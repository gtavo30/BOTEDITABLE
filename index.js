const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
const OpenAI = require("openai");
const fs = require('fs').promises;
const fsSync = require('fs');
const { Logtail } = require("@logtail/node");

// Inicializar Better Stack de forma más robusta
const logtail = new Logtail("AaptuBgpDT3T9491hvW1PTMt", {
    throwExceptions: false
});

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

// 📊 Función de logging MEJORADA - no bloquea el bot
async function log(message, data = {}, level = 'info') {
  const timestamp = new Date().toISOString();
  const logEntry = `${timestamp} ${message}`;
  
  // SIEMPRE mostrar en consola primero
  console.log(logEntry, data);
  
  // Enviar a Better Stack de forma asíncrona sin bloquear
  setImmediate(() => {
    try {
      const logData = { message, ...data };
      
      if (level === 'error') {
        logtail.error(message, logData);
      } else if (level === 'warn') {
        logtail.warn(message, logData);
      } else {
        logtail.info(message, logData);
      }
    } catch (err) {
      // Silencioso - no interrumpir el flujo del bot
    }
  });
}

// Flush periódico cada 10 segundos
setInterval(() => {
  logtail.flush().catch(() => {});
}, 10000);

// 🔥 CACHE para deduplicación de mensajes (en memoria)
const processedMessages = new Set();
const CACHE_CLEANUP_INTERVAL = 3600000; // 1 hora
const CACHE_MAX_SIZE = 10000;

// 🔥 NUEVO: Sistema de colas por usuario
const userQueues = new Map();
const userLocks = new Map(); // Para evitar race conditions en la creación de threads
const userTimers = new Map(); // Para manejar el debounce de 30 segundos

// 🔥 NUEVO: Cache de threads en memoria (se carga al inicio)
const threadCache = new Map();

// Configuración de debounce
const DEBOUNCE_TIME = 20000; // 20 segundos en milisegundos

// Limpiar cache periódicamente
setInterval(() => {
    if (processedMessages.size > CACHE_MAX_SIZE) {
        processedMessages.clear();
        console.log('📦 Message cache cleared');
    }
}, CACHE_CLEANUP_INTERVAL);

// 🔥 NUEVO: Cargar threads al iniciar el servidor
async function loadThreadsFromFile() {
    try {
        if (!fsSync.existsSync('users_threads.json')) {
            console.log('📝 Creating new users_threads.json file');
            await fs.writeFile('users_threads.json', JSON.stringify([], null, 2));
            return;
        }

        const data = await fs.readFile('users_threads.json', 'utf8');
        const usersThreads = JSON.parse(data);
        
        usersThreads.forEach(user => {
            threadCache.set(user['customer phone number'], user['thread id']);
        });
        
        console.log(`✅ Loaded ${threadCache.size} threads from file into cache`);
    } catch (error) {
        console.error('❌ Error loading threads:', error.message);
    }
}

// 🔥 NUEVO: Guardar thread en archivo y cache
async function saveThreadToFile(phoneNumber, threadId) {
    try {
        // Actualizar cache
        threadCache.set(phoneNumber, threadId);
        
        // Leer archivo actual
        let usersThreads = [];
        if (fsSync.existsSync('users_threads.json')) {
            const data = await fs.readFile('users_threads.json', 'utf8');
            usersThreads = JSON.parse(data);
        }
        
        // Verificar si ya existe
        const existingIndex = usersThreads.findIndex(user => user['customer phone number'] === phoneNumber);
        
        if (existingIndex >= 0) {
            // Actualizar existente
            usersThreads[existingIndex]['thread id'] = threadId;
        } else {
            // Agregar nuevo
            usersThreads.push({
                'customer phone number': phoneNumber,
                'appointment_made': false,
                'thread id': threadId
            });
        }
        
        // Guardar archivo
        await fs.writeFile('users_threads.json', JSON.stringify(usersThreads, null, 2));
        console.log(`💾 Thread saved for ${phoneNumber}`);
    } catch (error) {
        console.error('❌ Error saving thread:', error.message);
    }
}

// 🔥 NUEVO: Inicializar cola para un usuario
function initializeQueue(userId) {
    if (!userQueues.has(userId)) {
        userQueues.set(userId, {
            messages: [],
            processing: false,
            lastActivity: Date.now()
        });
        console.log(`📥 Queue initialized for user: ${userId}`);
    }
}

// 🔥 NUEVO: Procesar cola de mensajes (con debounce - combina múltiples mensajes)
async function processMessageQueue(userId, phone_no_id, token, platform = 'whatsapp') {
    const queue = userQueues.get(userId);
    
    if (!queue) {
        console.log(`⚠️ No queue found for user: ${userId}`);
        return;
    }
    
    if (queue.processing) {
        console.log(`⏳ Queue already processing for user: ${userId}`);
        return;
    }
    
    // Verificar si hay mensajes en la cola
    if (queue.messages.length === 0) {
        console.log(`📭 No messages in queue for ${userId}`);
        return;
    }
    
    queue.processing = true;
    queue.lastActivity = Date.now();
    
    console.log(`🔄 Processing ${queue.messages.length} messages for ${userId}`);
    
    try {
        // 🔥 NUEVO: Combinar todos los mensajes en la cola en uno solo
        const allMessages = queue.messages.map(m => m.text);
        const combinedMessage = allMessages.join('\n\n');
        
        console.log(`📨 Combined message from ${userId}:\n"${combinedMessage}"`);
        console.log(`📊 Total messages combined: ${allMessages.length}`);
        
        // Limpiar la cola
        queue.messages = [];
        
        // Procesar el mensaje combinado
        const assistantResponse = await getAssistantResponse(
            combinedMessage,
            phone_no_id,
            token,
            userId,
            platform
        );
        
        console.log(`🤖 Assistant response for ${userId}:`, assistantResponse);
        
        // Enviar respuesta según la plataforma
        if (platform === 'whatsapp') {
            await axios({
                method: "POST",
                url: `https://graph.facebook.com/v13.0/${phone_no_id}/messages?access_token=${token}`,
                data: {
                    messaging_product: "whatsapp",
                    to: userId,
                    text: { body: assistantResponse }
                },
                headers: { "Content-Type": "application/json" }
            });
        } else {
            await sendMessageToFacebook(userId, assistantResponse, token);
        }
        
        console.log(`✅ Response sent to ${userId}`);
        
    } catch (error) {
        console.error(`❌ Error processing messages for ${userId}:`, error.message);
        
        // Intentar enviar mensaje de error al usuario
        try {
            const errorMsg = "Perdón, hubo un problema procesando tu mensaje. ¿Puedes intentar de nuevo?";
            if (platform === 'whatsapp') {
                await axios({
                    method: "POST",
                    url: `https://graph.facebook.com/v13.0/${phone_no_id}/messages?access_token=${token}`,
                    data: {
                        messaging_product: "whatsapp",
                        to: userId,
                        text: { body: errorMsg }
                    },
                    headers: { "Content-Type": "application/json" }
                });
            } else {
                await sendMessageToFacebook(userId, errorMsg, token);
            }
        } catch (sendError) {
            console.error(`❌ Failed to send error message to ${userId}:`, sendError.message);
        }
    } finally {
        queue.processing = false;
        queue.lastActivity = Date.now();
        console.log(`✅ Queue processing completed for ${userId}`);
    }
}

// 🔥 NUEVO: Limpiar colas inactivas (cada 30 minutos)
setInterval(() => {
    const now = Date.now();
    const INACTIVE_THRESHOLD = 30 * 60 * 1000; // 30 minutos
    
    for (const [userId, queue] of userQueues.entries()) {
        if (!queue.processing && queue.messages.length === 0) {
            if (now - queue.lastActivity > INACTIVE_THRESHOLD) {
                userQueues.delete(userId);
                // Limpiar timer si existe
                if (userTimers.has(userId)) {
                    clearTimeout(userTimers.get(userId));
                    userTimers.delete(userId);
                }
                console.log(`🧹 Removed inactive queue for ${userId}`);
            }
        }
    }
}, 30 * 60 * 1000);

// 🔥 NUEVO: Programar procesamiento con debounce
function scheduleProcessing(userId, phone_no_id, token, platform) {
    // Si ya existe un timer para este usuario, cancelarlo
    if (userTimers.has(userId)) {
        clearTimeout(userTimers.get(userId));
        console.log(`⏰ Reset timer for ${userId} - waiting for more messages...`);
    }
    
    // Crear nuevo timer de 30 segundos
    const timer = setTimeout(() => {
        console.log(`⏰ Timer finished for ${userId} - processing messages now`);
        userTimers.delete(userId);
        processMessageQueue(userId, phone_no_id, token, platform).catch(error => {
            console.error('❌ Error in scheduled message processing:', error);
        });
    }, DEBOUNCE_TIME);
    
    userTimers.set(userId, timer);
    
    const queue = userQueues.get(userId);
    console.log(`⏰ Timer set for ${userId} - will process ${queue.messages.length} message(s) in 20 seconds`);
}

app.listen(8000 || process.env.PORT, async () => {
    console.log("🚀 Webhook is listening");
    await loadThreadsFromFile();
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
        if (!fsSync.existsSync('users_threads.json')) {
            console.log('users_threads.json does not exist yet');
            return;
        }

        const data = await fs.readFile('users_threads.json', 'utf8');
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
                            text: { body: followUpMessage }
                        },
                        headers: { "Content-Type": "application/json" }
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

// 🔥 CORREGIDO: Validación mejorada del número del lead
const sendApptNotificationToSalesMan = async (phone_no_id, token, leadPhoneNumber, recipientName, date, time, projectName, platform = 'whatsapp') => {
    await log('[sendApptNotification] Starting...', { 
        leadPhoneNumber,
        recipientName, 
        date, 
        time, 
        projectName, 
        platform 
    });
    
    try {
        // 🔥 VALIDACIÓN: Asegurar que NO se esté usando el número del vendedor
        if (leadPhoneNumber === SALES_MAN) {
            await log('[sendApptNotification] ERROR: Trying to use SALES_MAN number as lead!', { 
                leadPhoneNumber, 
                SALES_MAN 
            }, 'error');
            return "Error interno: El sistema detectó un número de teléfono incorrecto. Por favor verifica el número del cliente.";
        }
        
        // Validar que leadPhoneNumber sea un número de teléfono válido
        const phoneRegex = /^\+?[0-9]{10,15}$/;
        const isValidPhone = phoneRegex.test(leadPhoneNumber.replace(/\s/g, ''));
        
        if (!isValidPhone) {
            await log('[sendApptNotification] Invalid phone number', { leadPhoneNumber }, 'error');
            return "Error: El número de teléfono proporcionado no es válido. Por favor proporciona un número válido para agendar la cita.";
        }

        await log('[sendApptNotification] Validation passed', { leadPhoneNumber, SALES_MAN });

        // Enviar notificación via WhatsApp AL VENDEDOR con la info del LEAD
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
                                { 'type': 'text', 'text': leadPhoneNumber },
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

            await log('[sendApptNotification] Sending notification to salesman', { 
                salesman: SALES_MAN,
                leadName: recipientName,
                leadPhone: leadPhoneNumber,
                project: projectName
            });
            
            const response = await axios.post(url, message_payload, { headers });

            await log('[sendApptNotification] Notification sent successfully', { 
                messageId: response.data.messages?.[0]?.id 
            });
            
        } else if (platform === 'messenger' || platform === 'instagram') {
            console.log('[sendApptNotification] Messenger/Instagram: Sending notification via WhatsApp to salesman');
            
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
                                    { 'type': 'text', 'text': leadPhoneNumber },
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
            if (!fsSync.existsSync('users_threads.json')) {
                console.log('users_threads.json does not exist yet');
                return "Thank you for booking the appointment. We'll get back to you soon.";
            }

            const data = await fs.readFile('users_threads.json', 'utf8');
            const usersThreads = JSON.parse(data);

            const userThread = usersThreads.find(user => user['customer phone number'] === leadPhoneNumber);

            if (userThread) {
                userThread.appointment_made = true;
                await fs.writeFile('users_threads.json', JSON.stringify(usersThreads, null, 2));
                console.log(`✅ Appointment status updated to True for ${leadPhoneNumber} in users_threads.json`);
            }
        } catch (err) {
            console.error('Error updating appointment status:', err);
        }

        return "Thank you for booking the appointment. We'll get back to you soon.";

    } catch (error) {
        await log('[sendApptNotification] Exception occurred', {
            message: error.message,
            stack: error.stack,
            leadPhoneNumber,
            projectName
        }, 'error');
        return "Error notifying salesman";
    }
};

// 🔥 CORREGIDO: Usar el número del lead, no el del vendedor
async function addCustomerContactAndProjectToCRM(
    phone_no_id, 
    token, 
    leadPhoneNumber,
    firstName, 
    lastName, 
    email = '', 
    projectName, 
    comments = '',
    conversationHistory = []
) {
    await log('[addCustomer] Input:', { 
        leadPhoneNumber,
        firstName, 
        lastName, 
        email, 
        projectName,
        commentsLength: comments ? comments.length : 0,
        conversationLength: conversationHistory ? conversationHistory.length : 0
    });
    
    // 🔥 VALIDACIÓN: Asegurar que NO se esté usando el número del vendedor
    if (leadPhoneNumber === SALES_MAN) {
        await log('[addCustomer] ERROR: Trying to use SALES_MAN number as lead!', { 
            leadPhoneNumber, 
            SALES_MAN 
        }, 'error');
        return "Error interno: El sistema detectó un número de teléfono incorrecto. Por favor verifica el número del cliente.";
    }
    
    await log('[addCustomer] Using lead phone number', { leadPhoneNumber, projectName });
    
    if (!BITRIX_WEBHOOK_BASE) {
        await log('[addCustomer] BITRIX_WEBHOOK_BASE not set', {}, 'error');
        return "Error: CRM configuration missing";
    }

    const batchUrl = `${BITRIX_WEBHOOK_BASE.replace(/\/$/, '')}/batch.json`;
    
    const commands = {
        createContact: `crm.contact.add?FIELDS[NAME]=${encodeURIComponent('')}&FIELDS[LAST_NAME]=${encodeURIComponent(firstName + ' ' + lastName)}&FIELDS[EMAIL][0][VALUE]=${encodeURIComponent(email)}&FIELDS[EMAIL][0][VALUE_TYPE]=WORK&FIELDS[PHONE][0][VALUE]=${encodeURIComponent(leadPhoneNumber)}&FIELDS[PHONE][0][VALUE_TYPE]=WORK`,
        createDeal: `crm.deal.add?FIELDS[TITLE]=${encodeURIComponent('Lead - ' + firstName + ' ' + lastName)}&FIELDS[CONTACT_ID]=$result[createContact]&FIELDS[COMMENTS]=${encodeURIComponent(projectName)}&FIELDS[UF_CRM_1706240341362]=${encodeURIComponent(projectName)}`
    };

    if (comments) {
        const summaryText = '📋 RESUMEN DE CONVERSACIÓN:\n\n' + comments;
        commands.addSummary = `crm.timeline.comment.add?fields[ENTITY_ID]=$result[createDeal]&fields[ENTITY_TYPE]=deal&fields[COMMENT]=${encodeURIComponent(summaryText)}`;
        await log('[addCustomer] Adding summary', { summaryLength: summaryText.length });
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
        await log('[addCustomer] Sending batch request to Bitrix', { leadPhoneNumber, projectName });
        
        const response = await axios({
            method: 'POST',
            url: batchUrl,
            data: params.toString(),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        await log('[addCustomer] Batch response received', { 
            hasResult: !!response.data?.result,
            responseKeys: Object.keys(response.data || {})
        });

        if (response.data && response.data.result) {
            const dealId = response.data.result.result.createDeal;
            await log('[addCustomer] Deal created successfully', { 
                dealId, 
                leadPhoneNumber,
                projectName,
                firstName,
                lastName
            });
            
            if (response.data.result.result.addSummary) {
                await log('[addCustomer] Summary added to timeline');
            } else if (response.data.result.result_error && response.data.result.result_error.addSummary) {
                await log('[addCustomer] Error adding summary', { 
                    error: response.data.result.result_error.addSummary 
                }, 'error');
            }
            
            return "The customer contact has been saved - don't tell the customer about that it's just for our backend";
        } else {
            await log('[addCustomer] Batch error - no result', { 
                responseData: response.data 
            }, 'error');
            return null;
        }
    } catch (error) {
        await log('[addCustomer] Exception occurred', { 
            message: error.message,
            stack: error.stack,
            leadPhoneNumber,
            projectName
        }, 'error');
        return null;
    }
}

// 🔥 MEJORADO: getOrCreateThreadId con mejor manejo de concurrencia
const getOrCreateThreadId = async (phoneNumber) => {
    try {
        // Verificar cache primero
        if (threadCache.has(phoneNumber)) {
            console.log('✅ Found thread in cache for:', phoneNumber);
            return threadCache.get(phoneNumber);
        }

        // Adquirir lock para evitar crear threads duplicados
        while (userLocks.get(phoneNumber)) {
            console.log('⏳ Waiting for lock to be released for:', phoneNumber);
            await delay(100);
        }
        
        userLocks.set(phoneNumber, true);

        try {
            // Verificar cache de nuevo por si otro proceso lo creó
            if (threadCache.has(phoneNumber)) {
                console.log('✅ Found thread in cache (after lock) for:', phoneNumber);
                return threadCache.get(phoneNumber);
            }

            // Verificar en archivo
            if (fsSync.existsSync('users_threads.json')) {
                const data = await fs.readFile('users_threads.json', 'utf8');
                const usersThreads = JSON.parse(data);
                
                const existingThread = usersThreads.find(user => user['customer phone number'] === phoneNumber);
                if (existingThread) {
                    console.log('✅ Found existing thread in file for:', phoneNumber);
                    threadCache.set(phoneNumber, existingThread['thread id']);
                    return existingThread['thread id'];
                }
            }

            // Crear nuevo thread
            console.log('🆕 Creating new thread for:', phoneNumber);
            const newThread = await openai.beta.threads.create();
            const newThreadId = newThread.id;

            await saveThreadToFile(phoneNumber, newThreadId);
            console.log('✅ New thread created and saved:', newThreadId);

            return newThreadId;

        } finally {
            userLocks.delete(phoneNumber);
        }

    } catch (err) {
        console.error('❌ Error in getOrCreateThreadId:', err.message);
        console.error('Stack:', err.stack);
        userLocks.delete(phoneNumber);
        return null;
    }
};

// 🔥 MEJORADO: getAssistantResponse con reintentos y mejor manejo de errores
const getAssistantResponse = async function (prompt, phone_no_id, token, leadPhoneNumber, platform = 'whatsapp') {
    const maxRetries = 3;
    let attempt = 0;

    console.log('[getAssistantResponse] Called with leadPhoneNumber:', leadPhoneNumber);

    while (attempt < maxRetries) {
        try {
            attempt++;
            console.log(`🔄 Attempt ${attempt}/${maxRetries} for ${leadPhoneNumber}`);

            const thread = await getOrCreateThreadId(leadPhoneNumber);
            
            if (!thread) {
                console.error('❌ Failed to get or create thread');
                if (attempt < maxRetries) {
                    await delay(2000);
                    continue;
                }
                return "Perdón, ese mensaje no llegó bien. ¿Me lo puedes repetir?";
            }

            let enhancedPrompt = prompt;
            if (platform === 'messenger' || platform === 'instagram') {
                enhancedPrompt = `[SYSTEM: Este cliente está escribiendo desde ${platform.toUpperCase()}. Este es su ID: ${leadPhoneNumber}. IMPORTANTE: Cuando llames a las funciones addCustomerContactAndProjectToCRM o sendApptNotificationToSalesMan, DEBES incluir el parámetro recipientNumber con el número de teléfono que el cliente te proporcione en la conversación (ejemplo: +593984679525). NO uses el ID ${leadPhoneNumber} como número de teléfono.]\n\n${prompt}`;
            }

            const threadId = typeof thread === 'string' ? thread : thread.id;
            
            const message = await openai.beta.threads.messages.create(
                threadId,
                {
                    role: "user",
                    content: enhancedPrompt
                }
            );

            const run = await openai.beta.threads.runs.create(
                threadId,
                {
                    assistant_id: assistantId,
                }
            );

            console.log('✅ Run created:', run.id);

            const response = await checkStatusAndPrintMessages(threadId, run.id, phone_no_id, token, leadPhoneNumber, platform);
            
            // Si fue exitoso, retornar
            return response;

        } catch (error) {
            console.error(`❌ Error in getAssistantResponse (attempt ${attempt}/${maxRetries}):`, error.message);
            
            // Si es error de "run activo", esperar más tiempo
            if (error.message.includes('while a run') && error.message.includes('is active')) {
                console.log('⏳ Run is active, waiting before retry...');
                await delay(3000 * attempt); // Espera incremental
                
                if (attempt < maxRetries) {
                    continue; // Reintentar
                }
            } else {
                console.error('Stack:', error.stack);
            }
            
            if (attempt >= maxRetries) {
                return "Perdón, hubo un problema procesando tu mensaje. Por favor intenta de nuevo en un momento.";
            }
        }
    }
    
    return "Perdón, ese mensaje no llegó bien. ¿Me lo puedes repetir?";
};

// 🔥 CRÍTICO: Aquí está el fix principal - usar SIEMPRE el número del lead
const checkStatusAndPrintMessages = async (threadId, runId, phone_no_id, token, leadPhoneNumber, platform) => {
    try {
        let runStatus;
        let attempts = 0;
        const maxAttempts = 120;
        
        console.log('[checkStatus] Processing for lead:', leadPhoneNumber);
        
        while (attempts < maxAttempts) {
            attempts++;
            
            try {
                runStatus = await openai.beta.threads.runs.retrieve(threadId, runId);
            } catch (error) {
                console.error('❌ Error retrieving run status:', error.message);
                await delay(2000);
                continue;
            }
            
            console.log(`[${attempts}/${maxAttempts}] Run status:`, runStatus.status);
            
            if (runStatus.status === "completed") {
                break;
            } else if (runStatus.status === 'requires_action') {
                console.log("🔧 Requires action");

                const requiredActions = runStatus.required_action.submit_tool_outputs.tool_calls;
                console.log('Required actions:', JSON.stringify(requiredActions, null, 2));

                const dispatchTable = {
                    "addCustomerContactAndProjectToCRM": addCustomerContactAndProjectToCRM,
                    "sendApptNotificationToSalesMan": sendApptNotificationToSalesMan,
                    "appendDealChatResumen": appendDealChatResumen
                };

                let toolsOutput = [];

                for (const action of requiredActions) {
                    const funcName = action.function.name;
                    const functionArguments = JSON.parse(action.function.arguments);

                    if (dispatchTable[funcName]) {
                        console.log(`🔧 Executing function: ${funcName}`);
                        console.log('Function arguments received:', JSON.stringify(functionArguments, null, 2));
                        
                        try {
                            let output;
                            
                            if (funcName === 'addCustomerContactAndProjectToCRM') {
                                // 🔥 CRÍTICO: Usar el número del LEAD que está escribiendo
                                let phoneToUse = leadPhoneNumber;  // Default: usar el número del remitente
                                
                                // Solo si el asistente proporcionó un número Y es diferente al ID de Facebook
                                if (functionArguments.recipientNumber && 
                                    functionArguments.recipientNumber !== leadPhoneNumber &&
                                    functionArguments.recipientNumber.match(/^\+?[0-9]{10,15}$/)) {
                                    phoneToUse = functionArguments.recipientNumber;
                                    console.log('[addCustomer] ✅ Using phone number from assistant:', phoneToUse);
                                } else {
                                    console.log('[addCustomer] ✅ Using lead phone number (message sender):', phoneToUse);
                                }
                                
                                // Validación extra: NO usar el número del vendedor
                                if (phoneToUse === SALES_MAN) {
                                    console.error('[addCustomer] ❌ CRITICAL ERROR: Assistant provided SALES_MAN number!');
                                    phoneToUse = leadPhoneNumber;  // Forzar usar el número del lead
                                }
                                
                                output = await addCustomerContactAndProjectToCRM(
                                    phone_no_id,
                                    token,
                                    phoneToUse,  // 🔥 Usar el número correcto del LEAD
                                    functionArguments.firstName,
                                    functionArguments.lastName,
                                    functionArguments.email || '',
                                    functionArguments.projectName,
                                    functionArguments.comments || '',
                                    functionArguments.conversationHistory || []
                                );
                            } else if (funcName === 'sendApptNotificationToSalesMan') {
                                // 🔥 CRÍTICO: Usar el número del LEAD que está escribiendo
                                let phoneToUse = leadPhoneNumber;  // Default: usar el número del remitente
                                
                                // Solo si el asistente proporcionó un número Y es válido
                                if (functionArguments.recipientNumber && 
                                    functionArguments.recipientNumber !== leadPhoneNumber &&
                                    functionArguments.recipientNumber.match(/^\+?[0-9]{10,15}$/)) {
                                    phoneToUse = functionArguments.recipientNumber;
                                    console.log('[sendAppt] ✅ Using phone number from assistant:', phoneToUse);
                                } else {
                                    console.log('[sendAppt] ✅ Using lead phone number (message sender):', phoneToUse);
                                }
                                
                                // Validación extra: NO usar el número del vendedor
                                if (phoneToUse === SALES_MAN) {
                                    console.error('[sendAppt] ❌ CRITICAL ERROR: Assistant provided SALES_MAN number!');
                                    phoneToUse = leadPhoneNumber;  // Forzar usar el número del lead
                                }
                                
                                output = await sendApptNotificationToSalesMan(
                                    phone_no_id,
                                    token,
                                    phoneToUse,  // 🔥 Usar el número correcto del LEAD
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
                                    leadPhoneNumber,
                                    ...Object.values(functionArguments)
                                );
                            }
                            
                            console.log(`✅ Function ${funcName} completed. Output:`, output);
                            toolsOutput.push({ tool_call_id: action.id, output: JSON.stringify(output) });
                        } catch (error) {
                            console.error(`❌ Error executing function ${funcName}:`, error.message);
                            console.error('Stack:', error.stack);
                            toolsOutput.push({ 
                                tool_call_id: action.id, 
                                output: JSON.stringify({ error: error.message }) 
                            });
                        }
                    } else {
                        console.log("⚠️ Function not found:", funcName);
                    }
                }

                console.log('📤 Submitting tool outputs...');
                await openai.beta.threads.runs.submitToolOutputs(
                    threadId,
                    runId,
                    { tool_outputs: toolsOutput }
                );
                console.log('✅ Tool outputs submitted successfully');
            } else if (runStatus.status === 'failed') {
                console.error('❌ Run failed:', runStatus.last_error);
                return "Perdón, ese mensaje no llegó bien. ¿Me lo puedes repetir?";
            }
            
            await delay(1000);
        }
        
        if (attempts >= maxAttempts) {
            console.error('⚠️ TIMEOUT: Run exceeded maximum attempts (2 minutes)');
            return "Perdón, ese mensaje no llegó bien. ¿Me lo puedes repetir?";
        }

        let messages = await openai.beta.threads.messages.list(threadId);
        console.log("✅ Final messages retrieved, count:", messages.data.length);
        return messages.data[0].content[0].text.value;
    } catch (error) {
        console.error('❌ Error in checkStatusAndPrintMessages:', error.message);
        console.error('Stack:', error.stack);
        throw error; // Re-throw para que getAssistantResponse pueda reintentar
    }
};

function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

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
        console.log('[Facebook] ✅ Message sent successfully');
        return response.data;
    } catch (error) {
        console.error('[Facebook] ❌ Error sending message:', error.response ? error.response.data : error.message);
        throw error;
    }
}

app.post("/webhook", async (req, res) => {
    try {
        let body_param = req.body;

        if (!body_param || !body_param.object) {
            console.log('⚠️ Invalid webhook payload');
            return res.sendStatus(400);
        }

        console.log(JSON.stringify(body_param, null, 2));

        const object = body_param.object;
        
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
                
                // 🔥 NUEVO: Manejar mensajes desde anuncios de Instagram (referral)
                if (messageData.referral && messageType !== 'text') {
                    console.log('[WhatsApp] 📢 Referral detected from ad campaign');
                    console.log('[WhatsApp] 📢 Source:', messageData.referral.source_type);
                    console.log('[WhatsApp] 📢 Ad body:', messageData.referral.body);
                    
                    // Deduplicación
                    if (processedMessages.has(wamid)) {
                        console.log('[WhatsApp] ⚠️ Duplicate referral message, ignoring:', wamid);
                        return res.sendStatus(200);
                    }
                    processedMessages.add(wamid);
                    
                    console.log('[WhatsApp] 📨 Referral message from LEAD:', from);
                    
                    // Inicializar cola y agregar un mensaje simulado para procesar
                    initializeQueue(from);
                    
                    // Simular que el usuario escribió el mensaje del referral
                    const referralText = messageData.referral.body || "Hola, quiero más información del proyecto Porto Alegre";
                    userQueues.get(from).messages.push({ text: referralText });
                    
                    console.log(`📥 Referral message added to queue for LEAD ${from}`);
                    
                    // Responder inmediatamente a WhatsApp
                    res.sendStatus(200);
                    
                    // Programar procesamiento con debounce
                    scheduleProcessing(from, phone_no_id, token, 'whatsapp');
                    
                    return; // Salir aquí para no procesar más abajo
                }
                
                if (messageType !== 'text') {
                    console.log(`[WhatsApp] ⚠️ Ignoring non-text message type: ${messageType}`);
                    return res.sendStatus(200);
                }
                
                let msg_body = messageData.text.body;

                // 🔥 Deduplicación mejorada
                if (processedMessages.has(wamid)) {
                    console.log('[WhatsApp] ⚠️ Duplicate message detected, ignoring:', wamid);
                    return res.sendStatus(200);
                }
                processedMessages.add(wamid);

                console.log('[WhatsApp] 📨 Message received from LEAD:', from);
                console.log('[WhatsApp] 💬 Message body:', msg_body);

                // Manejar comando de follow-up
                if (from == FOLLOWUP_MESSAGES_TRIGGER_NUMBER) {
                    if (msg_body == FOLLOWUP_MESSAGES_TRIGGER_COMMAND) {
                        const followUpFunctionResponse = await followUpFunction(phone_no_id, token);
                        console.log(followUpFunctionResponse);
                    } else {
                        console.log(`Please select the right command to trigger the follow-up: "${FOLLOWUP_MESSAGES_TRIGGER_COMMAND}"`);
                    }
                    return res.sendStatus(200);
                }

                // 🔥 NUEVO: Agregar mensaje a cola y programar procesamiento con debounce
                initializeQueue(from);
                userQueues.get(from).messages.push({ text: msg_body });
                
                console.log(`📥 Message added to queue for LEAD ${from}. Queue size: ${userQueues.get(from).messages.length}`);
                
                // Responder inmediatamente a WhatsApp
                res.sendStatus(200);
                
                // 🔥 Programar procesamiento con debounce de 20 segundos
                scheduleProcessing(from, phone_no_id, token, 'whatsapp');

            } else {
                console.log('[WhatsApp] ℹ️ Non-message webhook (status/delivery), ignoring');
                res.sendStatus(200);
            }
        }
        else if (object === "page" || object === "instagram") {
            if (body_param.entry && body_param.entry[0].messaging && body_param.entry[0].messaging[0]) {
                const messagingEvent = body_param.entry[0].messaging[0];
                const senderId = messagingEvent.sender.id;
                const messageText = messagingEvent.message ? messagingEvent.message.text : null;
                const mid = messagingEvent.message ? messagingEvent.message.mid : null;

                const platform = object === "instagram" ? "instagram" : "messenger";
                const pageToken = object === "instagram" ? INSTAGRAM_PAGE_TOKEN : MESSENGER_PAGE_TOKEN;

                if (!pageToken) {
                    console.error(`[${platform}] ❌ Token not configured`);
                    return res.sendStatus(500);
                }

                if (!messageText) {
                    console.log(`[${platform}] ℹ️ Received event without text message`);
                    return res.sendStatus(200);
                }

                // 🔥 Deduplicación
                if (processedMessages.has(mid)) {
                    console.log(`[${platform}] ⚠️ Duplicate message detected, ignoring:`, mid);
                    return res.sendStatus(200);
                }
                processedMessages.add(mid);

                console.log(`[${platform}] 📨 Message received from LEAD ID:`, senderId);
                console.log(`[${platform}] 💬 Message body:`, messageText);

                // 🔥 NUEVO: Agregar mensaje a cola y programar procesamiento con debounce
                initializeQueue(senderId);
                userQueues.get(senderId).messages.push({ text: messageText });
                
                console.log(`📥 Message added to queue for ${senderId}. Queue size: ${userQueues.get(senderId).messages.length}`);
                
                // Responder inmediatamente
                res.sendStatus(200);
                
                // 🔥 Programar procesamiento con debounce de 20 segundos
                scheduleProcessing(senderId, null, pageToken, platform);

            } else {
                res.sendStatus(404);
            }
        }
        else {
            console.log('⚠️ Unknown webhook object:', object);
            res.sendStatus(404);
        }
    } catch (error) {
        console.error('❌ Error in webhook processing:', error);
        console.error('Stack:', error.stack);
        res.sendStatus(500);
    }
});

app.get("/", (req, res) => {
    res.status(200).send("hello bro");
});

app.get('/healthz', (_req, res) => {
    res.status(200).json({ 
        ok: true, 
        uptime: process.uptime(),
        queues: userQueues.size,
        threads: threadCache.size
    });
});
