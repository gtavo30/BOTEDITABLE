     [GET]200boteditable-qqjs.onrender.com/clientIP="35.197.97.226" requestID="2bc516bc-fcff-4f65" responseTimeMS=3 responseBytes=276 userAgent="Go-http-client/2.0"
     [POST]200boteditable-qqjs.onrender.com/webhookclientIP="173.252.127.26" requestID="06644b75-c6a5-49af" responseTimeMS=1698 responseBytes=270 userAgent="facebookexternalua"
     [POST]200boteditable-qqjs.onrender.com/webhookclientIP="173.252.95.114" requestID="6ab14148-7ff2-4f68" responseTimeMS=2 responseBytes=270 userAgent="facebookexternalua"
     [POST]200boteditable-qqjs.onrender.com/webhookclientIP="173.252.95.112" requestID="ee468b61-14da-46b5" responseTimeMS=2 responseBytes=270 userAgent="facebookexternalua"
     [POST]200boteditable-qqjs.onrender.com/webhookclientIP="173.252.127.2" requestID="b6c82a19-d3ac-4c34" responseTimeMS=2 responseBytes=270 userAgent="facebookexternalua"
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "239137435940794",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "593939182810",
              "phone_number_id": "253928731128192"
            },
            "contacts": [
              {
                "profile": {
                  "name": "~"
                },
                "wa_id": "593984679525"
              }
            ],
            "messages": [
              {
                "from": "593984679525",
                "id": "wamid.HBgMNTkzOTg0Njc5NTI1FQIAEhgUM0IzMzJEMzlBMkYxMjhFMEZDMTYA",
                "timestamp": "1760659222",
                "text": {
                  "body": "mandame el catalogo de porto alegre"
                },
                "type": "text"
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
[WhatsApp] Message received from: 593984679525
[WhatsApp] Message body: mandame el catalogo de porto alegre
[WhatsApp] Getting assistant response...
Created new thread for: 593984679525 Thread ID: thread_2LvB0ygnzwI0HrMvBoIsTTV4
Error in getAssistantResponse: 400 Invalid 'thread_id': 'undefined'. Expected an ID that begins with 'thread'.
Stack: Error: 400 Invalid 'thread_id': 'undefined'. Expected an ID that begins with 'thread'.
    at APIError.generate (/opt/render/project/src/node_modules/openai/error.js:45:20)
    at OpenAI.makeStatusError (/opt/render/project/src/node_modules/openai/core.js:302:33)
    at OpenAI.makeRequest (/opt/render/project/src/node_modules/openai/core.js:346:30)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
[WhatsApp] Assistant response: Lo siento, hubo un error. Por favor intenta de nuevo.
    at async getAssistantResponse (/opt/render/project/src/index.js:471:25)
    at async /opt/render/project/src/index.js:734:45
[WhatsApp] Response sent to user
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "239137435940794",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "593939182810",
              "phone_number_id": "253928731128192"
            },
            "statuses": [
              {
                "id": "wamid.HBgMNTkzOTg0Njc5NTI1FQIAERgSRjlBOUJEODNENTFGMEUwNEIyAA==",
                "status": "sent",
                "timestamp": "1760659225",
                "recipient_id": "593984679525",
                "conversation": {
                  "id": "ffeaa1cbc54959bae5d514606232decf",
                  "expiration_timestamp": "1760659225",
                  "origin": {
                    "type": "service"
                  }
                },
                "pricing": {
                  "billable": false,
                  "pricing_model": "PMP",
                  "category": "service",
                  "type": "free_customer_service"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
[WhatsApp] Non-message webhook (status/delivery), ignoring
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "239137435940794",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "593939182810",
              "phone_number_id": "253928731128192"
            },
            "statuses": [
              {
                "id": "wamid.HBgMNTkzOTg0Njc5NTI1FQIAERgSRjlBOUJEODNENTFGMEUwNEIyAA==",
                "status": "delivered",
                "timestamp": "1760659226",
                "recipient_id": "593984679525",
                "conversation": {
                  "id": "ffeaa1cbc54959bae5d514606232decf",
                  "origin": {
                    "type": "service"
                  }
                },
                "pricing": {
                  "billable": false,
                  "pricing_model": "PMP",
                  "category": "service",
                  "type": "free_customer_service"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
[WhatsApp] Non-message webhook (status/delivery), ignoring
{
  "object": "whatsapp_business_account",
  "entry": [
    {
      "id": "239137435940794",
      "changes": [
        {
          "value": {
            "messaging_product": "whatsapp",
            "metadata": {
              "display_phone_number": "593939182810",
              "phone_number_id": "253928731128192"
            },
            "statuses": [
              {
                "id": "wamid.HBgMNTkzOTg0Njc5NTI1FQIAERgSRjlBOUJEODNENTFGMEUwNEIyAA==",
                "status": "read",
                "timestamp": "1760659226",
                "recipient_id": "593984679525",
                "conversation": {
                  "id": "ffeaa1cbc54959bae5d514606232decf",
                  "origin": {
                    "type": "service"
                  }
                },
                "pricing": {
                  "billable": false,
                  "pricing_model": "PMP",
                  "category": "service",
                  "type": "free_customer_service"
                }
              }
            ]
          },
          "field": "messages"
        }
      ]
    }
  ]
}
[WhatsApp] Non-message webhook (status/delivery), ignoring
     ==> Detected service running on port 8000
     ==> Docs on specifying a port: https://render.com/docs/web-services#port-binding
Need better ways to work with logs? Try theRender CLI, Render MCP Server, or set up a log stream integration 
