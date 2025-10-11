const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
const OpenAI = require("openai");
const fs = require('fs');

require("dotenv").config();

// ✅ CAMBIO 1: Importar bitrixWebhookClient
const { appendDealChatResumen } = require('./bitrixWebhookClient');

const app = express().use(body_parser.json());

const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN;
const apiKey = process.env.OPENAI_API_KEY;
const assistantId = process.env.ASSISTANT_ID;
const SALES_MAN = process.env.SALES_MAN;
const BITRIX_WEBHOOK_BASE = process.env.BITRIX_WEBHOOK_BASE;
const FOLLOWUP_MESSAGES_TRIGGER_NUMBER = process.env.FOLLOWUP_MESSAGES_TRIGGER_NUMBER || 593999706271;
const FOLLOWUP_MESSAGES_TRIGGER_COMMAND = process.env.FOLLOWUP_MESSAGES_TRIGGER_COMMAND || "send follow up messages";

const openai = new OpenAI({
    apiKey: apiKey,
});

app.listen(8000 || process.env.PORT, () => {
    console.log("webhook is listening");
});

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

const sendApptNotificationToSalesMan = async (phone_no_id, token, recipientNumber, recipientName, date, time, projectName) => {
    try {
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

        const response = await axios.post(url, message_payload, { headers });

        console.log(response.data);
        console.log("Salesman notified of the appointment scheduled.");

        try {
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
        console.error('Error notifying salesman of the appointment notification:', error);
        return null;
    }
};

// ✅ CAMBIO 2: Función con BATCH para registro atómico
async function addCustomerContactAndProjectToCRM(phone_no_id, token, recipientNumber, firstName, lastName, email, projectName) {
    console.log('[addCustomer] Input:', { recipientNumber, firstName, lastName, email, projectName });
    
    if (!BITRIX_WEBHOOK_BASE) {
        console.error('[addCustomer] BITRIX_WEBHOOK_BASE not set');
        return "Error: CRM configuration missing";
    }

    const batchUrl = `${BITRIX_WEBHOOK_BASE.replace(/\/$/, '')}/batch.json`;
    
    const commands = {
        createContact: `crm.contact.add?FIELDS[NAME]=${encodeURIComponent('')}&FIELDS[LAST_NAME]=${encodeURIComponent(firstName + ' ' + lastName)}&FIELDS[EMAIL][0][VALUE]=${encodeURIComponent(email)}&FIELDS[EMAIL][0][VALUE_TYPE]=WORK&FIELDS[PHONE][0][VALUE]=${encodeURIComponent(recipientNumber)}&FIELDS[PHONE][0][VALUE_TYPE]=WORK`,
        createDeal: `crm.deal.add?FIELDS[TITLE]=${encodeURIComponent('Lead - ' + firstName + ' ' + lastName)}&FIELDS[CONTACT_ID]=$result[createContact]&FIELDS[COMMENTS]=${encodeURIComponent(projectName)}&FIELDS[UF_CRM_1706240341362]=${encodeURIComponent(projectName)}`,
        addNote: `crm.timeline.comment.add?ENTITY_ID=$result[createDeal]&ENTITY_TYPE=deal&COMMENT=${encodeURIComponent('Lead registrado desde WhatsApp. Proyecto: ' + projectName)}`
    };

    const params = new URLSearchParams();
    params.set('halt', '0');
    for (const [key, value] of Object.entries(commands)) {
        params.set(`cmd[${key}]`, value);
    }

    try {
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
            return "The customer contact has been saved - don't tell the customer about that it's just for our backend";
        } else {
            console.error('[addCustomer] Batch error:', response.data);
            return null;
        }
    } catch (error) {
        console.error('[addCustomer] Error:', error.message);
        return null;
    }
}

const getOrCreateThreadId = async (phoneNumber) => {
    try {
        let usersThreads;

        const data = fs.readFileSync('users_threads.json');
        usersThreads = JSON.parse(data);

        const existingThread = usersThreads.find(user => user['customer phone number'] === phoneNumber);
        if (existingThread) {
            return existingThread['thread id'];
        }

        const newThreadId = await openai.beta.threads.create();

        usersThreads.push({ 'customer phone number': phoneNumber, 'appointment_made': false, 'thread id': newThreadId });

        fs.writeFileSync('users_threads.json', JSON.stringify(usersThreads, null, 2));

        return newThreadId;
    } catch (err) {
        console.error('Error in getOrCreateThreadId:', err.message);
        return null;
    }
};

const getAssistantResponse = async function (prompt, phone_no_id, token, recipientNumber) {
    const thread = await getOrCreateThreadId(recipientNumber);

    const message = await openai.beta.threads.messages.create(
        thread.id,
        {
            role: "user",
            content: prompt
        }
    );

    const run = await openai.beta.threads.runs.create(
        thread.id,
        {
            assistant_id: assistantId,
        }
    );

    console.log(run.id);

    const checkStatusAndPrintMessages = async (threadId, runId) => {
        try {
            let runStatus;
            while (true) {
                runStatus = await openai.beta.threads.runs.retrieve(threadId, runId);
                console.log(runStatus.status);
                
                if (runStatus.status === "completed") {
                    break;
                } else if (runStatus.status === 'requires_action') {
                    console.log("Requires action");

                    const requiredActions = runStatus.required_action.submit_tool_outputs.tool_calls;
                    console.log(requiredActions);

                    // ✅ CAMBIO 3: Agregar appendDealChatResumen al dispatch table
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
                            console.log("dispatchTable[funcName]", dispatchTable[funcName]);
                            try {
                                const output = await dispatchTable[funcName](phone_no_id, token, recipientNumber, ...Object.values(functionArguments));
                                console.log(output);
                                toolsOutput.push({ tool_call_id: action.id, output: JSON.stringify(output) });
                            } catch (error) {
                                console.log(`Error executing function ${funcName}: ${error}`);
                            }
                        } else {
                            console.log("Function not found");
                        }
                    }

                    await openai.beta.threads.runs.submitToolOutputs(
                        thread.id,
                        run.id,
                        { tool_outputs: toolsOutput }
                    );
                }
                
                console.log("Run is not completed yet.");
                // ✅ CAMBIO 4: DESCOMENTAR delay para polling estable
                await delay(1000);
            }

            let messages = await openai.beta.threads.messages.list(threadId);
            console.log("messages", messages);
            return messages.data[0].content[0].text.value;
        } catch (error) {
            console.error('Error in checkStatusAndPrintMessages:', error.message);
        }
    };

    return await checkStatusAndPrintMessages(thread.id, run.id);
};

// ✅ CAMBIO 5: Función delay restaurada
function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

app.post("/webhook", async (req, res) => {
    try {
        let body_param = req.body;

        console.log(JSON.stringify(body_param, null, 2));

        if (body_param.object) {
            if (body_param.entry &&
                body_param.entry[0].changes &&
                body_param.entry[0].changes[0].value.messages &&
                body_param.entry[0].changes[0].value.messages[0]
            ) {
                let phone_no_id = body_param.entry[0].changes[0].value.metadata.phone_number_id;
                let from = body_param.entry[0].changes[0].value.messages[0].from;
                let msg_body = body_param.entry[0].changes[0].value.messages[0].text.body;

                if (from == FOLLOWUP_MESSAGES_TRIGGER_NUMBER) {
                    if (msg_body == FOLLOWUP_MESSAGES_TRIGGER_COMMAND) {
                        const followUpFunctionResponse = await followUpFunction(phone_no_id, token);
                        console.log(followUpFunctionResponse);
                    } else {
                        console.log(`Please select the right command to trigger the follow-up: "${FOLLOWUP_MESSAGES_TRIGGER_COMMAND}"`);
                    }
                } else {
                    let assistantResponse = await getAssistantResponse(msg_body, phone_no_id, token, from);

                    console.log("assistantResponse", assistantResponse);

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

                    res.sendStatus(200);
                }

            } else {
                res.sendStatus(404);
            }
        }
    } catch (error) {
        console.error('Error in webhook processing:', error);
        res.sendStatus(500);
    }
});

app.get("/", (req, res) => {
    res.status(200).send("hello bro");
});

app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true, uptime: process.uptime() });
});
