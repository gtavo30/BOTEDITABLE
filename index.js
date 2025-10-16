const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
const OpenAI = require("openai");
const fs = require('fs');

require("dotenv").config();

const { appendDealChatResumen } = require('./bitrixWebhookClient');

const app = express().use(body_parser.json());

// WhatsApp tokens
const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN;

// Messenger/Instagram tokens
const MESSENGER_PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN;
const INSTAGRAM_PAGE_TOKEN = process.env.INSTAGRAM_PAGE_TOKEN;

// OpenAI & Bitrix
const apiKey = process.env.OPENAI_API_KEY;
const assistantId = process.env.ASSISTANT_ID;
const SALES_MAN = process.env.SALES_MAN;
const BITRIX_WEBHOOK_BASE = process.env.BITRIX_WEBHOOK_BASE;
const FOLLOWUP_MESSAGES_TRIGGER_NUMBER = process.env.FOLLOWUP_MESSAGES_TRIGGER_NUMBER || 593999706271;
const FOLLOWUP_MESSAGES_TRIGGER_COMMAND = process.env.FOLLOWUP_MESSAGES_TRIGGER_COMMAND || "send follow up messages";

const openai = new OpenAI({
    apiKey: apiKey,
});

// 🔥 CACHE para deduplicación de mensajes (en memoria)
const processedMessages = new Set();
const CACHE_CLEANUP_INTERVAL = 3600000; // 1 hora
const CACHE_MAX_SIZE = 10000;

// Limpiar cache periódicamente
setInterval(() => {
    if (processedMessages.size > CACHE_MAX_SIZE) {
        processedMessages.clear();
        console.log('📦 Message cache cleared');
    }
}, CACHE_CLEANUP_INTERVAL);

app.listen(8000 || process.env.PORT, () => {
    console.log("webhook is listening");
});

// ✅ Webhook verification - funciona para WhatsApp, Messenger e Instagram
app.get("/webhook", (req, res) => {
    let mode = req.query["hub.mode"];
    let challenge = req.query["hub.challenge"];
    let token = req.query["hub.verify_token"];

    if (mode && token) {
        if (mode === "subscribe" && token === mytoken) {
            console.log("Webhook verified");
            res.status(200).send(challenge);
        } else {
            res.status(403).send("Forbidden");
        }
    }
});

const followUpFunction = async (phone_no_id, token) => {
    try {
        // Verificar que el archivo existe
        if (!fs.existsSync('users_threads.json')) {
            console.log('users_threads.json does not exist yet');
            return;
        }

        const data = fs.readFileSync('users_threads.json');
        const usersThreads = JSON.parse(data);

        for (const userThread of usersThreads) {
            const phoneNumber = userThread['customer phone number'];
            const appointmentMade = userThread.appointment_made || false;

            if (!appointmentMade) {
                try {
                    const followUpMessage = "Hi there, I hope this message finds you well. Following up our previous conversation, you always have an option of booking an appointment with our sales team. Just let me know and I'll schedule one for you!";
                    await axios({
                        method: "POST",
                        url: `https://graph.facebook.com/v13.0/${phone_no_id}/messages?access_token=${token}`,
                        data: {
                            messaging_product: "whatsapp",
                            to: phoneNumber,
                            type: "text",
                            text: {
                                body: followUpMessage
                            }
                        },
                        headers: {
                            "Content-Type": "application/json"
                        }
                    });
                    console.log(`Follow-up message sent successfully to ${phoneNumber}`);
                } catch (error) {
                    console.error(`Error sending follow-up message to ${phoneNumber}:`, error);
                }
            }
        }
    } catch (err) {
        console.error('Error reading file:', err);
    }
};

const sendCatalogFile = async (phone_no_id, token, recipientNumber, fileId, projectName, platform = 'whatsapp') => {
    console.log('[sendCatalog] Starting...', { recipientNumber, projectName, fileId, platform });
    
    try {
        if (!fileId || fileId === 'undefined') {
            console.error('[sendCatalog] ❌ No fileId provided');
            return `No se pudo encontrar el catálogo de ${projectName}. Por favor verifica el nombre del proyecto.`;
        }
        
        console.log('[sendCatalog] Downloading file from OpenAI, File ID:', fileId);
        
        // Obtener el archivo de OpenAI
        const fileContent = await openai.files.content(fileId);
        const fileBuffer = Buffer.from(await fileContent.arrayBuffer());
        
        console.log('[sendCatalog] File downloaded, size:', fileBuffer.length, 'bytes');
        
        if (platform === 'whatsapp') {
            // Para WhatsApp: primero subir el archivo a Facebook, luego enviarlo
            const FormData = require('form-data');
            const form = new FormData();
            
            const fileName = `Catalogo_${projectName.replace(/\s+/g, '_')}.pdf`;
            
            form.append('file', fileBuffer, {
                filename: fileName,
                contentType: 'application/pdf'
            });
            form.append('messaging_product', 'whatsapp');
            
            const uploadUrl = `https://graph.facebook.com/v18.0/${phone_no_id}/media`;
            const uploadHeaders = {
                'Authorization': `Bearer ${token}`,
                ...form.getHeaders()
            };
            
            console.log('[sendCatalog] Uploading file to WhatsApp...');
            const uploadResponse = await axios.post(uploadUrl, form, { headers: uploadHeaders });
            const mediaId = uploadResponse.data.id;
            
            console.log('[sendCatalog] File uploaded, media ID:', mediaId);
            
            // Paso 2: Enviar el documento
            const sendUrl = `https://graph.facebook.com/v18.0/${phone_no_id}/messages`;
            const sendData = {
                messaging_product: 'whatsapp',
                to: recipientNumber,
                type: 'document',
                document: {
                    id: mediaId,
                    caption: `📄 Catálogo ${projectName}`,
                    filename: fileName
                }
            };
            
            console.log('[sendCatalog] Sending document to user...');
            await axios.post(sendUrl, sendData, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            console.log('[sendCatalog] ✅ Catalog sent successfully via WhatsApp');
            return `Catálogo de ${projectName} enviado exitosamente`;
            
        } else if (platform === 'messenger' || platform === 'instagram') {
            // Para Messenger/Instagram, no se pueden enviar PDFs directamente
            console.log('[sendCatalog] Platform does not support PDF files:', platform);
            return `Por ${platform} no puedo enviarte el PDF directamente. ¿Me proporcionas tu email para enviártelo por correo? O puedes contactarnos por WhatsApp para recibirlo.`;
        }
        
    } catch (error) {
        console.error('[sendCatalog] Error:', error.message);
        console.error('[sendCatalog] Stack:', error.stack);
        if (error.response) {
            console.error('[sendCatalog] Response data:', error.response.data);
        }
        return `Error enviando el catálogo de ${projectName}. Por favor intenta de nuevo.`;
    }
};

// Mapeo de proyectos a File IDs de OpenAI
const PROJECT_CATALOGS = {
    'porto alegre': {
        fileId: process.env.CATALOG_PORTO_ALEGRE_FILE_ID || 'file-xxx',
        name: 'Catálogo Porto Alegre.pdf'
    },
    'bosques de armenia': {
        fileId: process.env.CATALOG_BOSQUES_FILE_ID || 'file-xxx',
        name: 'Catálogo Bosques de Armenia.pdf'
    },
    'terraverde': {
        fileId: process.env.CATALOG_TERRAVERDE_FILE_ID || 'file-xxx',
        name: 'Catálogo Terraverde.pdf'
    }
    // Agrega más proyectos aquí
};

const sendApptNotificationToSalesMan = async (phone_no_id, token, recipientNumber, recipientName, date, time, projectName, platform = 'whatsapp') => {
    console.log('[sendApptNotification] Starting...', { recipientName, recipientNumber, date, time, projectName, platform });
    
    try {
        // Validar que recipientNumber sea un número de teléfono válido
        const phoneRegex = /^\+?[0-9]{10,15}$/;
        const isValidPhone = phoneRegex.test(recipientNumber.replace(/\s/g, ''));
        
        if (!isValidPhone) {
            console.error('[sendApptNotification] ❌ Invalid phone number:', recipientNumber);
            return "Error: El número de teléfono proporcionado no es válido. Por favor proporciona un número válido para agendar la cita.";
        }

        // Enviar notificación via WhatsApp
        if (platform === 'whatsapp' && phone_no_id) {
            const message_payload = {
                'messaging_product': 'whatsapp',
                'to': SALES_MAN,
                'type': 'template',
                'template': {
                    'name': 'salesman_appoimant_contact',
                    'language': { 'code': 'es' },
                    'components': [
                        {
                            'type': 'body',
                            'parameters': [
                                { 'type': 'text', 'text': recipientName },
                                { 'type': 'text', 'text': recipientNumber },
                                { 'type': 'text', 'text': date },
                                { 'type': 'text', 'text': time },
                                { 'type': 'text', 'text': projectName },
                            ]
                        }
                    ]
                }
            };

            const url = `https://graph.facebook.com/v18.0/${phone_no_id}/messages`;
            const headers = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            };

            console.log('[sendApptNotification] Sending to salesman...', SALES_MAN);
            const response = await axios.post(url, message_payload, { headers });

            console.log('[sendApptNotification] Response:', response.data);
            console.log("Salesman notified of the appointment scheduled via WhatsApp.");
        } else if (platform === 'messenger' || platform === 'instagram') {
            // Para Messenger/Instagram, enviamos notificación via WhatsApp al vendedor también
            // usando el número de teléfono del cliente que él proporcionó
            console.log('[sendApptNotification] Messenger/Instagram: Sending notification via WhatsApp to salesman');
            
            // Necesitamos usar el phone_no_id de WhatsApp (el de la empresa)
            // Este debe estar configurado como variable de entorno
            const whatsappPhoneId = process.env.WHATSAPP_PHONE_ID || phone_no_id;
            const whatsappToken = process.env.TOKEN;
            
            if (whatsappPhoneId && whatsappToken) {
                const message_payload = {
                    'messaging_product': 'whatsapp',
                    'to': SALES_MAN,
                    'type': 'template',
                    'template': {
                        'name': 'salesman_appoimant_contact',
                        'language': { 'code': 'es' },
                        'components': [
                            {
                                'type': 'body',
                                'parameters': [
                                    { 'type': 'text', 'text': recipientName },
                                    { 'type': 'text', 'text': recipientNumber },
                                    { 'type': 'text', 'text': date },
                                    { 'type': 'text', 'text': time },
                                    { 'type': 'text', 'text': projectName },
                                ]
                            }
                        ]
                    }
                };

                const url = `https://graph.facebook.com/v18.0/${whatsappPhoneId}/messages`;
                const headers = {
                    'Authorization': `Bearer ${whatsappToken}`,
                    'Content-Type': 'application/json'
                };

                const response = await axios.post(url, message_payload, { headers });
                console.log('[sendApptNotification] Notification sent via WhatsApp from', platform);
            } else {
                console.error('[sendApptNotification] ⚠️ WHATSAPP_PHONE_ID not configured for', platform);
            }
        }

        // Actualizar estado de appointment en users_threads.json
        try {
            if (!fs.existsSync('users_threads.json')) {
                console.log('users_threads.json does not exist yet');
                return "Thank you for booking the appointment. We'll get back to you soon.";
            }

            const data = fs.readFileSync('users_threads.json');
            const usersThreads = JSON.parse(data);

            const userThread = usersThreads.find(user => user['customer phone number'] === recipientNumber);

            if (userThread) {
                userThread.appointment_made = true;
                fs.writeFileSync('users_threads.json', JSON.stringify(usersThreads, null, 2));
                console.log(`Appointment status updated to True for ${recipientNumber} in users_threads.json`);
            }
        } catch (err) {
            console.error('Error updating appointment status:', err);
        }

        return "Thank you for booking the appointment. We'll get back to you soon.";

    } catch (error) {
        console.error('[sendApptNotification] Error:', error.message);
        console.error('[sendApptNotification] Stack:', error.stack);
        if (error.response) {
            console.error('[sendApptNotification] Response data:', error.response.data);
        }
        return "Error notifying salesman";
    }
};

async function addCustomerContactAndProjectToCRM(
    phone_no_id, 
    token, 
    recipientNumber, 
    firstName, 
    lastName, 
    email = '', 
    projectName, 
    comments = '',
    conversationHistory = []
) {
    console.log('[addCustomer] Input:', { 
        recipientNumber, 
        firstName, 
        lastName, 
        email, 
        projectName,
        commentsLength: comments ? comments.length : 0,
        conversationLength: conversationHistory ? conversationHistory.length : 0
    });
    
    console.log('[addCustomer] Comments content:', comments);
    
    if (!BITRIX_WEBHOOK_BASE) {
        console.error('[addCustomer] BITRIX_WEBHOOK_BASE not set');
        return "Error: CRM configuration missing";
    }

    const batchUrl = `${BITRIX_WEBHOOK_BASE.replace(/\/$/, '')}/batch.json`;
    
    const commands = {
        createContact: `crm.contact.add?FIELDS[NAME]=${encodeURIComponent('')}&FIELDS[LAST_NAME]=${encodeURIComponent(firstName + ' ' + lastName)}&FIELDS[EMAIL][0][VALUE]=${encodeURIComponent(email)}&FIELDS[EMAIL][0][VALUE_TYPE]=WORK&FIELDS[PHONE][0][VALUE]=${encodeURIComponent(recipientNumber)}&FIELDS[PHONE][0][VALUE_TYPE]=WORK`,
        createDeal: `crm.deal.add?FIELDS[TITLE]=${encodeURIComponent('Lead - ' + firstName + ' ' + lastName)}&FIELDS[CONTACT_ID]=$result[createContact]&FIELDS[COMMENTS]=${encodeURIComponent(projectName)}&FIELDS[UF_CRM_1706240341362]=${encodeURIComponent(projectName)}`
    };

    if (comments) {
        const summaryText = '📋 RESUMEN DE CONVERSACIÓN:\n\n' + comments;
        commands.addSummary = `crm.timeline.comment.add?fields[ENTITY_ID]=$result[createDeal]&fields[ENTITY_TYPE]=deal&fields[COMMENT]=${encodeURIComponent(summaryText)}`;
        console.log('[addCustomer] Adding summary with length:', summaryText.length);
    } else {
        const defaultNote = 'Lead registrado desde WhatsApp. Proyecto: ' + projectName;
        commands.addNote = `crm.timeline.comment.add?fields[ENTITY_ID]=$result[createDeal]&fields[ENTITY_TYPE]=deal&fields[COMMENT]=${encodeURIComponent(defaultNote)}`;
    }

    const params = new URLSearchParams();
    params.set('halt', '0');
    for (const [key, value] of Object.entries(commands)) {
        params.set(`cmd[${key}]`, value);
    }

    try {
        console.log('[addCustomer] Sending batch request...');
        const response = await axios({
            method: 'POST',
            url: batchUrl,
            data: params.toString(),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        console.log('[addCustomer] Batch response:', JSON.stringify(response.data));

        if (response.data && response.data.result) {
            const dealId = response.data.result.result.createDeal;
            console.log('[addCustomer] Deal created with ID:', dealId);
            
            if (response.data.result.result.addSummary) {
                console.log('[addCustomer] ✅ Summary added to timeline successfully');
            } else if (response.data.result.result_error && response.data.result.result_error.addSummary) {
                console.error('[addCustomer] ❌ Error adding summary:', response.data.result.result_error.addSummary);
            }
            
            return "The customer contact has been saved - don't tell the customer about that it's just for our backend";
        } else {
            console.error('[addCustomer] Batch error:', response.data);
            return null;
        }
    } catch (error) {
        console.error('[addCustomer] Error:', error.message);
        console.error('[addCustomer] Stack:', error.stack);
        return null;
    }
}

const getOrCreateThreadId = async (phoneNumber) => {
    try {
        let usersThreads = [];

        // Crear archivo si no existe
        if (!fs.existsSync('users_threads.json')) {
            fs.writeFileSync('users_threads.json', JSON.stringify([], null, 2));
            console.log('Created users_threads.json file');
        }

        const data = fs.readFileSync('users_threads.json');
        usersThreads = JSON.parse(data);

        const existingThread = usersThreads.find(user => user['customer phone number'] === phoneNumber);
        if (existingThread) {
            console.log('Found existing thread for:', phoneNumber);
            return existingThread['thread id'];
        }

        // Crear nuevo thread
        const newThread = await openai.beta.threads.create();
        const newThreadId = newThread.id;

        usersThreads.push({ 
            'customer phone number': phoneNumber, 
            'appointment_made': false, 
            'thread id': newThreadId 
        });

        fs.writeFileSync('users_threads.json', JSON.stringify(usersThreads, null, 2));
        console.log('Created new thread for:', phoneNumber, 'Thread ID:', newThreadId);

        return newThreadId;
    } catch (err) {
        console.error('Error in getOrCreateThreadId:', err.message);
        console.error('Stack:', err.stack);
        return null;
    }
};

const getAssistantResponse = async function (prompt, phone_no_id, token, recipientNumber, platform = 'whatsapp') {
    try {
        const thread = await getOrCreateThreadId(recipientNumber);
        
        if (!thread) {
            console.error('Failed to get or create thread');
            return "Lo siento, hubo un error al iniciar la conversación. Por favor intenta de nuevo.";
        }

        // 🔥 Agregar contexto de plataforma para Messenger/Instagram
        let enhancedPrompt = prompt;
        if (platform === 'messenger' || platform === 'instagram') {
            enhancedPrompt = `[SYSTEM: Este cliente está escribiendo desde ${platform.toUpperCase()}. No tienes su número de teléfono. IMPORTANTE: Cuando llames a las funciones addCustomerContactAndProjectToCRM o sendApptNotificationToSalesMan, DEBES incluir el parámetro recipientNumber con el número de teléfono que el cliente te proporcione (ejemplo: +593984679525). NO uses ningún otro identificador.]\n\n${prompt}`;
        }

        const message = await openai.beta.threads.messages.create(
            thread.id,
            {
                role: "user",
                content: enhancedPrompt
            }
        );

    const run = await openai.beta.threads.runs.create(
        thread.id || thread,
        {
            assistant_id: assistantId,
        }
    );

    console.log('Run ID:', run.id);

    const checkStatusAndPrintMessages = async (threadId, runId) => {
        try {
            let runStatus;
            let attempts = 0;
            const maxAttempts = 60;
            
            while (attempts < maxAttempts) {
                attempts++;
                
                try {
                    runStatus = await openai.beta.threads.runs.retrieve(threadId, runId);
                } catch (error) {
                    console.error('Error retrieving run status:', error.message);
                    await delay(2000);
                    continue;
                }
                
                console.log(`[${attempts}/${maxAttempts}] Run status:`, runStatus.status);
                
                if (runStatus.status === "completed") {
                    break;
                } else if (runStatus.status === 'requires_action') {
                    console.log("Requires action");

                    const requiredActions = runStatus.required_action.submit_tool_outputs.tool_calls;
                    console.log('Required actions:', JSON.stringify(requiredActions, null, 2));

                    const dispatchTable = {
                        "addCustomerContactAndProjectToCRM": addCustomerContactAndProjectToCRM,
                        "sendApptNotificationToSalesMan": sendApptNotificationToSalesMan,
                        "appendDealChatResumen": appendDealChatResumen,
                        "sendCatalogFile": sendCatalogFile
                    };

                    let toolsOutput = [];

                    for (const action of requiredActions) {
                        const funcName = action.function.name;
                        const functionArguments = JSON.parse(action.function.arguments);

                        if (dispatchTable[funcName]) {
                            console.log(`Executing function: ${funcName}`);
                            console.log('Arguments:', JSON.stringify(functionArguments, null, 2));
                            
                            try {
                                let output;
                                
                                if (funcName === 'addCustomerContactAndProjectToCRM') {
                                    // Para Messenger/Instagram, usar el número de teléfono del usuario si lo proporcionó
                                    // En lugar del recipientNumber (que es el Facebook ID)
                                    let phoneNumber = functionArguments.recipientNumber || recipientNumber;
                                    
                                    // Si es Messenger/Instagram y el número parece ser un Facebook ID, advertir
                                    if ((platform === 'messenger' || platform === 'instagram') && phoneNumber === recipientNumber) {
                                        console.warn('⚠️ [addCustomer] Using Facebook ID as phone number. Assistant should provide recipientNumber parameter.');
                                        console.warn('⚠️ [addCustomer] RecipientNumber from function args:', functionArguments.recipientNumber);
                                        console.warn('⚠️ [addCustomer] Default recipientNumber (Facebook ID):', recipientNumber);
                                    }
                                    
                                    output = await addCustomerContactAndProjectToCRM(
                                        phone_no_id,
                                        token,
                                        phoneNumber,
                                        functionArguments.firstName,
                                        functionArguments.lastName,
                                        functionArguments.email || '',
                                        functionArguments.projectName,
                                        functionArguments.comments || '',
                                        functionArguments.conversationHistory || []
                                    );
                                } else if (funcName === 'sendApptNotificationToSalesMan') {
                                    // Para WhatsApp: usar el número del remitente
                                    // Para Messenger/Instagram: usar el número que proporcionó el usuario
                                    let phoneNumber = functionArguments.recipientNumber;
                                    
                                    if (!phoneNumber || phoneNumber === recipientNumber) {
                                        if (platform === 'whatsapp') {
                                            // Para WhatsApp, usar el número del remitente
                                            phoneNumber = recipientNumber;
                                            console.log('[sendAppt] ✅ Using WhatsApp sender number:', phoneNumber);
                                        } else {
                                            console.warn('⚠️ [sendAppt] Missing phone number for Messenger/Instagram');
                                            phoneNumber = recipientNumber;
                                        }
                                    }
                                    
                                    output = await sendApptNotificationToSalesMan(
                                        phone_no_id,
                                        token,
                                        phoneNumber,
                                        functionArguments.recipientName,
                                        functionArguments.date,
                                        functionArguments.time,
                                        functionArguments.projectName,
                                        platform
                                    );
                                } else if (funcName === 'appendDealChatResumen') {
                                    output = await appendDealChatResumen(
                                        phone_no_id,
                                        token,
                                        recipientNumber,
                                        ...Object.values(functionArguments)
                                    );
                                } else if (funcName === 'sendCatalogFile') {
                                    output = await sendCatalogFile(
                                        phone_no_id,
                                        token,
                                        recipientNumber,
                                        functionArguments.projectName,
                                        platform
                                    );
                                }
                                
                                console.log(`Function ${funcName} completed. Output:`, output);
                                toolsOutput.push({ tool_call_id: action.id, output: JSON.stringify(output) });
                            } catch (error) {
                                console.error(`Error executing function ${funcName}:`, error.message);
                                console.error('Stack:', error.stack);
                                toolsOutput.push({ 
                                    tool_call_id: action.id, 
                                    output: JSON.stringify({ error: error.message }) 
                                });
                            }
                        } else {
                            console.log("Function not found:", funcName);
                        }
                    }

                    console.log('Submitting tool outputs...');
                    await openai.beta.threads.runs.submitToolOutputs(
                        thread.id,
                        run.id,
                        { tool_outputs: toolsOutput }
                    );
                    console.log('Tool outputs submitted successfully');
                } else if (runStatus.status === 'failed') {
                    console.error('Run failed:', runStatus.last_error);
                    return "Lo siento, hubo un error procesando tu solicitud.";
                }
                
                console.log("Run is not completed yet, waiting...");
                await delay(1000);
            }
            
            if (attempts >= maxAttempts) {
                console.error('⚠️ TIMEOUT: Run exceeded maximum attempts (2 minutes)');
                return "Lo siento, hubo un problema procesando tu solicitud. Por favor intenta de nuevo.";
            }

            let messages = await openai.beta.threads.messages.list(threadId);
            console.log("Final messages retrieved, count:", messages.data.length);
            return messages.data[0].content[0].text.value;
        } catch (error) {
            console.error('Error in checkStatusAndPrintMessages:', error.message);
            console.error('Stack:', error.stack);
            return "Lo siento, hubo un error. Por favor intenta de nuevo.";
        }
    };

    return await checkStatusAndPrintMessages(thread.id || thread, run.id);
};

function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

// 🔥 Función para enviar mensaje a Messenger/Instagram
async function sendMessageToFacebook(recipientId, message, pageToken) {
    try {
        const response = await axios({
            method: "POST",
            url: `https://graph.facebook.com/v18.0/me/messages`,
            data: {
                recipient: { id: recipientId },
                message: { text: message }
            },
            headers: {
                "Content-Type": "application/json"
            },
            params: {
                access_token: pageToken
            }
        });
        console.log('[Facebook] Message sent successfully');
        return response.data;
    } catch (error) {
        console.error('[Facebook] Error sending message:', error.response ? error.response.data : error.message);
        throw error;
    }
}

// 🔥 WEBHOOK PRINCIPAL - Maneja WhatsApp, Messenger e Instagram
app.post("/webhook", async (req, res) => {
    try {
        let body_param = req.body;

        // Validación básica
        if (!body_param || !body_param.object) {
            console.log('Invalid webhook payload');
            return res.sendStatus(400);
        }

        console.log(JSON.stringify(body_param, null, 2));

        const object = body_param.object;
        
        // ========== WHATSAPP ==========
        if (object === "whatsapp_business_account") {
            if (body_param.entry &&
                body_param.entry[0].changes &&
                body_param.entry[0].changes[0].value.messages &&
                body_param.entry[0].changes[0].value.messages[0]
            ) {
                let phone_no_id = body_param.entry[0].changes[0].value.metadata.phone_number_id;
                let from = body_param.entry[0].changes[0].value.messages[0].from;
                let messageData = body_param.entry[0].changes[0].value.messages[0];
                let messageType = messageData.type;
                let wamid = messageData.id;
                
                // Solo procesar mensajes de texto
                if (messageType !== 'text') {
                    console.log(`[WhatsApp] Ignoring non-text message type: ${messageType}`);
                    return res.sendStatus(200);
                }
                
                let msg_body = messageData.text.body;

                // 🔥 Deduplicación: verificar si ya procesamos este mensaje
                if (processedMessages.has(wamid)) {
                    console.log('[WhatsApp] ⚠️ Duplicate message detected, ignoring:', wamid);
                    return res.sendStatus(200);
                }
                processedMessages.add(wamid);

                console.log('[WhatsApp] Message received from:', from);
                console.log('[WhatsApp] Message body:', msg_body);

                if (from == FOLLOWUP_MESSAGES_TRIGGER_NUMBER) {
                    if (msg_body == FOLLOWUP_MESSAGES_TRIGGER_COMMAND) {
                        const followUpFunctionResponse = await followUpFunction(phone_no_id, token);
                        console.log(followUpFunctionResponse);
                    } else {
                        console.log(`Please select the right command to trigger the follow-up: "${FOLLOWUP_MESSAGES_TRIGGER_COMMAND}"`);
                    }
                } else {
                    console.log('[WhatsApp] Getting assistant response...');
                    let assistantResponse = await getAssistantResponse(msg_body, phone_no_id, token, from, 'whatsapp');

                    console.log("[WhatsApp] Assistant response:", assistantResponse);

                    await axios({
                        method: "POST",
                        url: "https://graph.facebook.com/v13.0/" + phone_no_id + "/messages?access_token=" + token,
                        data: {
                            messaging_product: "whatsapp",
                            to: from,
                            text: {
                                body: assistantResponse
                            }
                        },
                        headers: {
                            "Content-Type": "application/json"
                        }
                    });

                    console.log('[WhatsApp] Response sent to user');
                    res.sendStatus(200);
                }
            } else {
                // Webhook sin mensaje de texto (status updates, etc.)
                console.log('[WhatsApp] Non-message webhook (status/delivery), ignoring');
                res.sendStatus(200);
            }
        }
        // ========== MESSENGER / INSTAGRAM ==========
        else if (object === "page" || object === "instagram") {
            if (body_param.entry && body_param.entry[0].messaging && body_param.entry[0].messaging[0]) {
                const messagingEvent = body_param.entry[0].messaging[0];
                const senderId = messagingEvent.sender.id;
                const messageText = messagingEvent.message ? messagingEvent.message.text : null;
                const mid = messagingEvent.message ? messagingEvent.message.mid : null;

                const platform = object === "instagram" ? "Instagram" : "Messenger";
                const pageToken = object === "instagram" ? INSTAGRAM_PAGE_TOKEN : MESSENGER_PAGE_TOKEN;

                if (!pageToken) {
                    console.error(`[${platform}] Token not configured`);
                    return res.sendStatus(500);
                }

                // Ignorar eventos sin texto (delivery, read receipts, etc.)
                if (!messageText) {
                    console.log(`[${platform}] Received event without text message`);
                    return res.sendStatus(200);
                }

                // 🔥 Deduplicación: verificar si ya procesamos este mensaje
                if (processedMessages.has(mid)) {
                    console.log(`[${platform}] ⚠️ Duplicate message detected, ignoring:`, mid);
                    return res.sendStatus(200);
                }
                processedMessages.add(mid);

                console.log(`[${platform}] Message received from:`, senderId);
                console.log(`[${platform}] Message body:`, messageText);

                console.log(`[${platform}] Getting assistant response...`);
                let assistantResponse = await getAssistantResponse(messageText, null, pageToken, senderId, platform.toLowerCase());

                console.log(`[${platform}] Assistant response:`, assistantResponse);

                await sendMessageToFacebook(senderId, assistantResponse, pageToken);

                console.log(`[${platform}] Response sent to user`);
                res.sendStatus(200);
            } else {
                res.sendStatus(404);
            }
        }
        else {
            console.log('Unknown webhook object:', object);
            res.sendStatus(404);
        }
    } catch (error) {
        console.error('Error in webhook processing:', error);
        console.error('Stack:', error.stack);
        res.sendStatus(500);
    }
});

app.get("/", (req, res) => {
    res.status(200).send("hello bro");
});

app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, uptime: process.uptime() });
});
