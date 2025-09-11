const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
const OpenAI = require("openai");
const fs = require('fs');

require("dotenv").config();

const app = express().use(body_parser.json());

const token = process.env.TOKEN;
const mytoken = process.env.MYTOKEN
const apiKey = process.env.OPENAI_API_KEY
const assistantId = process.env.ASSISTANT_ID
const SALES_MAN = process.env.SALES_MAN
const CRM_BASE_URL = process.env.CRM_BASE_URL
const FOLLOWUP_MESSAGES_TRIGGER_NUMBER = process.env.FOLLOWUP_MESSAGES_TRIGGER_NUMBER || 593999706271
const FOLLOWUP_MESSAGES_TRIGGER_COMMAND = process.env.FOLLOWUP_MESSAGES_TRIGGER_COMMAND || "send follow up messages"

const openai = new OpenAI({
    apiKey: apiKey, // Replace with your OpenAI API key
});

const messageQueue = {};

app.listen(8000 || process.env.PORT, () => {
    console.log("webhook is listening");
});

app.get("/webhook", (req, res) => {
    let mode = req.query["hub.mode"];
    let challenge = req.query["hub.challenge"];
    let token = req.query["hub.verify_token"];

    if (mode && token) {
        console.log("&");
        if (mode === "subscribe" && token === mytoken) {
            console.log("hello get");
            res.status(200).send(challenge);
        } else {
            res.status(403);
        }
    }
});

const followUpFunction = async (phone_no_id, token) => {
    try {
        // Read the file synchronously
        const data = fs.readFileSync('users_threads.json');
        const usersThreads = JSON.parse(data);

        // Loop through the entries
        for (const userThread of usersThreads) {
            const phoneNumber = userThread['customer phone number'];
            const appointmentMade = userThread.appointment_made || false;

            // Check if appointment is not made (False)
            if (!appointmentMade) {
                // Add your logic here to send a follow-up message to the customer with phone number 'phoneNumber'
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
        // Define the message payload with template and parameters
        const message_payload = {
            'messaging_product': 'whatsapp',
            'to': SALES_MAN,
            'type': 'template',
            'template': {
                'name': 'salesman_appoimant_contact', // replace this with the actual template name
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

        // Construct the complete URL
        const url = `https://graph.facebook.com/v18.0/${phone_no_id}/messages`;

        // Set headers
        const headers = {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };

        // Make the POST request using Axios
        const response = await axios.post(url, message_payload, { headers });

        // Print the response
        console.log(response.data);
        console.log("Salesman notified of the appointment scheduled.");

        // Open the users_threads.json and make the appointment_made value turned to True
        try {
            const data = fs.readFileSync('users_threads.json');
            const usersThreads = JSON.parse(data);

            // Find the user thread with the matching recipientNumber
            const userThread = usersThreads.find(user => user['customer phone number'] === recipientNumber);

            if (userThread) {
                // Update the appointment_made value to True
                userThread.appointment_made = true;

                // Save the updated array back to the file
                fs.writeFileSync('users_threads.json', JSON.stringify(usersThreads, null, 2));

                console.log(`Appointment status updated to True for ${recipientNumber} in users_threads.json`);
            }
        } catch (err) {
            // Handle errors
            console.error('Error updating appointment status:', err);
        }

        return "Thank you for booking the appointment. We'll get back to you soon.";

    } catch (error) {
        // Handle errors
        console.error('Error notifying salesman of the appointment notification:', error);
        return null;
    }
};

async function addCustomerContactAndProjectToCRM(phone_no_id, token, recipientNumber, firstName, lastName, email, projectName) {
    console.log(phone_no_id, token, recipientNumber, firstName, lastName, email);
    const baseUrl = CRM_BASE_URL;

    // const url = `${baseUrl}?FIELDS[NAME]=${encodeURIComponent(firstName)}&FIELDS[LAST_NAME]=${encodeURIComponent(lastName)}&FIELDS[EMAIL][0][VALUE]=${encodeURIComponent(email)}&FIELDS[PHONE][0][VALUE]=${encodeURIComponent(recipientNumber)}`;

    const url = `${baseUrl}?FIELDS[NAME]=${encodeURIComponent('')}&FIELDS[LAST_NAME]=${encodeURIComponent(firstName + ' ' + lastName)}&FIELDS[EMAIL][0][VALUE]=${encodeURIComponent(email)}&FIELDS[PHONE][0][VALUE]=${encodeURIComponent(recipientNumber)}&FIELDS[EMAIL][0][VALUE_TYPE]=WORK&FIELDS[PHONE][0][VALUE_TYPE]=WORK&FIELDS[COMMENTS]=${encodeURIComponent(projectName)}&FIELDS[UF_CRM_1706240341362]=${encodeURIComponent(projectName)}`;
    console.log("url", url);

    try {
        const response = await axios.get(url);
        console.log(response);
        // Call sendSalesMan function after successfully adding the contact
        // const salesManResponse = await sendSalesMan(phone_no_id, token, recipientNumber, firstName, lastName, email);

        return "The customer contact has been saved - don't tell the customer about that it's just for our backend";
    } catch (error) {
        console.error('Error:', error);
        return null; // or handle the error as needed
    }
}

const getOrCreateThreadId = async (phoneNumber) => {
    try {
        let usersThreads;

        // Read the file synchronously
        const data = fs.readFileSync('users_threads.json');
        usersThreads = JSON.parse(data);

        // Check if the phone number is already in the file
        const existingThread = usersThreads.find(user => user['customer phone number'] === phoneNumber);
        if (existingThread) {
            return existingThread['thread id'];
        }

        // Create a new thread id
        const newThreadId = await openai.beta.threads.create();

        // Add the new thread to the usersThreads array
        usersThreads.push({ 'customer phone number': phoneNumber, 'appointment_made': false, 'thread id': newThreadId });

        // Save the updated array back to the file
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

                    const dispatchTable = {
                        // "sendMultipleImages": sendMultipleImages,
                        // "sendMapUrl": sendMapUrl,
                        "addCustomerContactAndProjectToCRM": addCustomerContactAndProjectToCRM,
                        "sendApptNotificationToSalesMan": sendApptNotificationToSalesMan
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
                // await delay(1000);
            }

            let messages = await openai.beta.threads.messages.list(threadId);
            console.log("messages", messages);
            return messages.data[0].content[0].text.value;
        } catch (error) {
            console.error('Error in checkStatusAndPrintMessages:', error.message);
        }
    };

    // Call checkStatusAndPrintMessages function
    return await checkStatusAndPrintMessages(thread.id, run.id);


    // function delay(ms) {
    //     return new Promise((resolve) => {
    //         setTimeout(resolve, ms);
    //     });
    // }

};

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
                    }
                    else {
                        console.log(`Please select the right command to trigger the follow-up: "${FOLLOWUP_MESSAGES_TRIGGER_COMMAND}"`);
                    }
                }
                else {
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

async function sendResponse(response, phone_no_id, token, to) {
    const url = `https://graph.facebook.com/v13.0/${phone_no_id}/messages?access_token=${token}`;

    try {
        const axiosConfig = {
            method: "POST",
            url,
            data: {
                messaging_product: "whatsapp",
                to: to,
                text: {
                    body: response
                }
            },
            headers: {
                "Content-Type": "application/json"
            }
        };

        const axiosResponse = await axios(axiosConfig);
        console.log("Response sent successfully:", axiosResponse.data);
    } catch (error) {
        console.error('Error sending response:', error);
    }
}

// app.post("/webhook", async (req, res) => {
//     try {
//         let body_param = req.body;

//         console.log(JSON.stringify(body_param, null, 2));

//         if (body_param.object) {
//             if (body_param.entry &&
//                 body_param.entry[0].changes &&
//                 body_param.entry[0].changes[0].value.messages &&
//                 body_param.entry[0].changes[0].value.messages[0]
//             ) {
//                 let phone_no_id = body_param.entry[0].changes[0].value.metadata.phone_number_id;
//                 let from = body_param.entry[0].changes[0].value.messages[0].from;
//                 let msg_body = body_param.entry[0].changes[0].value.messages[0].text.body;

//                 // Check if there's an existing message queue for the recipient
//                 if (!messageQueue[phone_no_id]) {
//                     messageQueue[phone_no_id] = {
//                         messages: [],
//                         timeoutId: null
//                     };
//                 }

//                 // Append the current message to the queue
//                 messageQueue[phone_no_id].messages.push({
//                     body: msg_body,
//                     time: new Date().toISOString()
//                 });

//                 // If there's already a timeout set, clear it
//                 if (messageQueue[phone_no_id].timeoutId) {
//                     clearTimeout(messageQueue[phone_no_id].timeoutId);
//                 }

//                 // Set a new timeout for 2 minutes
//                 messageQueue[phone_no_id].timeoutId = setTimeout(async () => {
//                     // Generate response using all accumulated messages
//                     const allMessages = messageQueue[phone_no_id].messages.map(message => message.body).join('\n');
//                     delete messageQueue[phone_no_id]; // Clear the queue

//                     // Process and generate response using allMessages array
//                     const response = await getAssistantResponse(allMessages, phone_no_id, token, from);

//                     // Send the response back
//                     await sendResponse(response, phone_no_id, token, from);

//                     res.sendStatus(200);
//                 }, 120000); // 2 minutes timeout

//                 // Acknowledge the receipt of the message without processing it immediately
//                 res.sendStatus(200);
//             } else {
//                 res.sendStatus(404);
//             }
//         }
//     } catch (error) {
//         console.error('Error in webhook processing:', error);
//         res.sendStatus(500);
//     }
// });

app.get("/", (req, res) => {
    res.status(200).send("hello bro");
})