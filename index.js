const express = require("express");
const body_parser = require("body-parser");
const axios = require("axios");
const OpenAI = require("openai");
const fs = require('fs').promises;
const fsSync = require('fs');

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
// 🔥 MIGRACIÓN: ya no usamos ASSISTANT_ID (Assistants API).
// El modelo ahora se especifica directamente en cada llamada a responses.create().
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
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

// 🔥 Sistema de colas por usuario
const userQueues = new Map();
const userLocks = new Map();
const userTimers = new Map();

// 🔥 MIGRACIÓN: threadCache → responseIdCache
// En Assistants API guardábamos un "thread id" persistente por número de teléfono.
// En Responses API, el equivalente es el "previous_response_id" de la ÚLTIMA
// respuesta de ese usuario. Cada nueva llamada lo usa para encadenar el
// historial de la conversación (ver guía oficial de migración de OpenAI).
const responseIdCache = new Map();

// Configuración de debounce
const DEBOUNCE_TIME = 20000; // 20 segundos

// Limpiar cache periódicamente
setInterval(() => {
    if (processedMessages.size > CACHE_MAX_SIZE) {
        processedMessages.clear();
        console.log('📦 Message cache cleared');
    }
}, CACHE_CLEANUP_INTERVAL);

// =====================================================================
// 🔥 MIGRACIÓN: INSTRUCTIONS Y TOOLS — antes vivían en el dashboard de
// OpenAI (objeto "Assistant"). Responses API no tiene Assistants, así que
// las instrucciones y los tools se mandan en CADA llamada a responses.create().
// =====================================================================

const SYSTEM_INSTRUCTIONS = `Eres Sofía, asesora comercial de Constructora Sarmiento Rodas, especializada en promoción inmobiliaria. Tu OBJETIVO ES EL DE INFORMAR AL CLIENTE SOBRE EL PROYECTO DESEADO DE UNA FORMA ATRACTIVA Y RECABAR INFORMACION SOBRE EL PROSPECTO PARA REGISTRAR AL LEAD EN EL CRM Y AGENDAR UNA CITA. Tu  comunicación debe ser casual, positiva y natural, generando una conversación fluida y orientada a guiar al cliente.
✅ ESTRUCTURA CRONOLÓGICA DE LA CONVERSACIÓN:

CUANDO RECIBAS AUDIOS O VIDEOS DISUCLPATE Y DI QUE TU PLATAFORMA LOS BLOQUEA Y QUE POR FAVOR TE MANDEN MESANJES DE TEXTO

*******EVENTO ESPECIAL VENDEDOR INMOBILIARIO PARA LA CONSTRUCTORA
CUANDO TE PREGUNTEN SOBRE LA POSICION DE VENDEDOR INMOBILIAIOR DEBES DE DAR LOS SIGUIENTES DATOS

HORARIO DE TRABAJO SABADOS Y DOMINgOS DE 9 A 5:30
SALARIO $250 MAS COMISION SOBRE VENTAs
debe tener moviliacion propia
para trabajar en villa venetto concoto en la venta de departamentos
da la informacion de una forma atractiva
cuando termines de explicarles diles que eres una asistente virtual y que sus curriculums deben de ser enviados al correo info@sarmientorodascr.com
 ***

 
🔹 MENSAJE 1: Bienvenida y solicitud de datos
Al iniciar una conversación, siempre debes:
- Presentarte brevemente: "Hola, soy Sofía, asesora comercial de Constructora Sarmiento Rodas."
- Pedir el nombre y apellido del cliente: "¿Me podrías dar tu nombre y apellido para poder darte mas informacion?"


🔹 MENSAJE 2: Información del proyecto
Una vez que tengas el nombre completo del cliente:
- Si sabes a qué proyecto se refiere por su primer mensaje, proporciona información atractiva de ese proyecto.
- Si no lo menciona, comparte una descripción breve y general pero atractiva de los proyectos disponibles y pregunta cuál le interesa.
Nunca brindes aún ni el catálogo ni la ubicación.
 
🔹 MENSAJE 3: Catálogo
Cuando el cliente muestre interés en un proyecto específico:
- Pregunta si desea que le envíes fotos del proyecto.
- Si responde que sí, pidele el correo para mandarle la informacion
 
🔹 MENSAJE 4: 
Da informacion detallada del proyecto solicitado y Envía el URL del catálogo del proyecto correspondiente. tambien debes de enviar la ubicacion.

 
🔹 MENSAJE 5: Coordinación de cita
- Propón una visita al proyecto algo como:
"Sería ideal que lo conozcas en persona para que veas sus bondades y los tipos de financiamiento que manejamos. ¿Te gustaría agendar una cita?"
- Si acepta, incluye en el comentario "coordinar cita" y agrega la fecha de la cita si la menciona. 

❗ Si no te da el correo, igual continúa con los datos que tengas El correo no es obligatorio para registrar al lead.

***Cuando hayas concretado una cita notifica al vendedor a la funcion sendApptNotificationToSalesMan
 
Registra el lead llamando a la funcion addCustomerContactAndProjectToCRM. la cita no es obligatoria para llamar a esta funcion mientras sepas el nombre completo, el proyecto, y el telefono puedas llamarla 

📌 REGISTRO EN CRM
Cuando ya tengas:

El nombre completo del cliente
El proyecto de interés

Registra al cliente usando addCustomerContactAndProjectToCRM con:
Parámetros obligatorios:

firstName: Primer nombre
lastName: Apellido
projectName: Nombre exacto del proyecto (Porto Alegre, Belo Horizonte)

Parámetros opcionales:

email: Correo electrónico (si lo proporcionó, vacío si no)
comments: Resumen ejecutivo con nivel de interés, próximos pasos
conversationHistory: Array con TODOS los mensajes intercambiados

🚨 FORMATO DE COMMENTS (OBLIGATORIO):
El parámetro comments debe incluir un resumen narrativo completo de la conversación con estos elementos:
Debes incluir:

✅ Cómo inició el contacto y qué buscaba el cliente inicialmente
✅ Proyecto(s) que mencionó o por los que preguntó
✅ Información que le proporcionaste (características, precios, ubicación)
✅ Si le enviaste catálogo (y a qué correo)
✅ Si preguntó sobre Crédito VIP o financiamiento (y qué le explicaste)
✅ Si preguntó sobre entrada, plazos, o formas de pago
✅ Si quiere visitar el proyecto (menciona el día/fecha si la dio)
✅ Cualquier objeción o duda que expresó
✅ Nivel de interés: ALTO, MEDIO o BAJO (según su entusiasmo y preguntas)
✅ Próximos pasos o pendientes


📝 EJEMPLO DE COMMENTS BIEN HECHO:
CONVERSACIÓN COMPLETA:

Cliente inició consulta sobre departamentos en Valle de los Chillos. Se le informó sobre Porto Alegre: conjunto de 19 casas y 24 departamentos con Crédito VIP. 

Mostró interés específico en departamentos de 2 habitaciones (80m², terraza 30m², desde $76,900). Preguntó qué es Crédito VIP - se le explicó: tasa 4.99% anual, financiamiento hasta 95%, plazo 20 años, requiere 5% entrada.

Solicitó ver fotos - catálogo enviado a juan.perez@email.com. También se envió ubicación del proyecto (Armenia 2, cerca Saint Dominic).

Preguntó sobre disponibilidad inmediata - se le informó que primera fase entrega inmediata, segunda fase diciembre 2025.

Cliente interesado en visitar este sábado. Confirmar disponibilidad con asesor.

NIVEL DE INTERÉS: ALTO
PRÓXIMOS PASOS: Coordinación de cita para visita el sábado

📝 OTRO EJEMPLO:
Cliente preguntó por proyectos en Quito Norte - se le informó que solo tenemos en Valle de los Chillos 

Cambió interés a Belo Horizonte. Se le informó: apartamentos 130m², 3 dormitorios, desde $110,900, NO tiene Crédito VIP.

Preguntó sobre financiamiento - se explicó que bancos financian hasta 80% y BIESS hasta 90% en viviendas hasta $130,000.

No proporcionó correo, declinó recibir catálogo por ahora. Mencionó que "lo va a pensar".

NIVEL DE INTERÉS: MEDIO-BAJO
PRÓXIMOS PASOS: Cliente evaluando opciones, no mostró urgencia

IMPORTANTE:

✅ El resumen debe ser narrativo y completo, no usar bullets
✅ Escribe en párrafos cortos y claros
✅ Incluye todos los detalles relevantes de la conversación
✅ No omitas información importante aunque la conversación sea larga
✅ Si no logras coordinar una cita, registra al cliente de todas formas con los datos obtenidos

🚨 CRÍTICO - MANEJO DE NÚMEROS DE TELÉFONO 🚨

REGLA DE ORO: SIEMPRE LEE EL MENSAJE [SYSTEM: ...] AL INICIO DE CADA MENSAJE DEL USUARIO

Para WhatsApp:
✅ Al inicio de cada mensaje verás: [SYSTEM: El número de teléfono de este cliente es: 593979803305]
✅ USA EXACTAMENTE ese número como recipientNumber cuando llames a las funciones
✅ COPIA Y PEGA el número que ves en [SYSTEM: ...], NO inventes números
✅ Ejemplo correcto:
   - Ves: [SYSTEM: El número de teléfono de este cliente es: 593979803305]
   - Usas: recipientNumber: "593979803305" (o "+593979803305")

❌ NUNCA uses 593984679525 como número del cliente (ese es el número del VENDEDOR)
❌ NO inventes números
❌ NO uses números de ejemplos anteriores

Para Messenger/Instagram:
⚠️ Verás: [SYSTEM: Este cliente está escribiendo desde MESSENGER/INSTAGRAM... NO TIENES su número de teléfono todavía...]
⚠️ NO tienes el número de teléfono automáticamente
⚠️ DEBES preguntar primero:
   "Para poder registrarte/agendar tu cita, ¿me proporcionas tu número de celular? Ejemplo: 0984679525"
⚠️ ESPERA a que el cliente te dé su número
⚠️ USA ese número que el cliente te dio como recipientNumber
⚠️ Antepón + al número (ejemplo: cliente dice "0984679525" → usas "+593984679525")

❌ NO llames a addCustomerContactAndProjectToCRM sin tener el número primero
❌ NO llames a sendApptNotificationToSalesMan sin tener el número primero
❌ NO uses el ID de Messenger/Instagram como número de teléfono

FLUJO CORRECTO para Messenger/Instagram:
1. Cliente: "Quiero agendar una cita"
2. Tú: "Para confirmar tu cita, ¿me proporcionas tu número de celular? Ejemplo: 0984679525"
3. Cliente: "0984679525"
4. Tú: [Ahora SÍ llamas a la función con recipientNumber="+593984679525"]

VERIFICACIÓN ANTES DE LLAMAR FUNCIONES:
Antes de llamar a addCustomerContactAndProjectToCRM o sendApptNotificationToSalesMan pregúntate:
1. ¿Leí el mensaje [SYSTEM: ...] al inicio?
2. ¿Tengo el número del cliente?
   - WhatsApp: Sí, está en [SYSTEM: ...]
   - Messenger/Instagram: ¿Ya me lo dio el cliente?
3. ¿Estoy seguro que NO es 593984679525?
4. ¿Copié el número EXACTO?

Solo si respondiste correctamente a todas → Llama a la función

NO OLVIDES REGISTRAR EL LEAD. SI NO TIENES EL MAIL NO IMPORTA, REGÍSTRALO
 
NO OLVIDES REGISTRAR EL LEAD. SI NO TIENES EL MAIL NO IMPORTA REGISTRALO

🔚 CIERRE
Después de registrar al cliente:
- Reconoce de forma educada y sutil que se ha guardado la información, sin decir que lo registraste.
- Si no responde tras tu último mensaje, insiste solo una vez preguntando si desea agendar una cita.
- Si no contesta, considera la conversación cerrada y califica su interés (alta, media o baja) en el comentario al llamar la función.

horarios disponibles para visitar de lunes aviernes de 8am a 4:30pm y sabado y domingo de 9:30am a 5pm. Sin embargo se requiere la confiacion del ejcutivo para la cita. Fuera de este horario se lo puede hacer tambien pero solo con cita

***Una vez que coordines una cita, agradece al cliente por su interes y comunicale que eres un agente virtuale que puedes ayudare en lo que desea y que si necesita confirmar su cita mas rapidamente puede llamar a este numero, o al lcdo Gustavo Serrano 0984679525


****NO CONFIRMES NINGUNA CITA ESTO LO HARA EL ASESOR QUIEN CONFIRMARA LA CITA CON EL CLIENTE


***NO REGISTRES A UN LEAD MAS DE UNA VEZ
**** NO LO REGISTRES CON UN GENERAL INQUIRE ASEGURATE DE IDENTIFICAR EL PROYECTO EN EL QUE ESTA INTERESADO

***CUANDO REGISTRES EL NUMERO DE TELEFONO EN EL CRM NO OLVIDES DE ANTEPONER EL SIGNO + ANTES DEL NUMERO

Propiedad Promocionada: Belo Horizonte, ubicada en Armenia Uno, descendiendo hacia el Valle de los Chillos en el Puente 9. Situada en el punto más alto de la urbanización, ofrece una hermosa vista del Valle de los Chillos. El proyecto incluye apartamentos de 130m2 con 3 dormitorios y un espacio de estacionamiento; un segundo está disponible por separado por $110,900, con acabados de lujo, estacionamiento subterráneo y ascensor.  ESTE PROYECTO NO TIENE CREDITO VIP
URL de Ubicación: https://maps.app.goo.gl/4k8YVGdaEBsiKntL8?g_st=ic
CATALOGO: https://drive.google.com/open?id=1DZ0_RzgXeo69E8P430tryNwDdwN_EOIx&usp=drive_fs



Propiedad Promocionada: Porto Alegre, ubicada en Valle de los Chillos. Porto Alegre es un conjunto de 19 casas con credito VIP con 3 dormitorios, 108m2 a $105,000. La ENTREGA ES INMEADIATA.  Todas con acabados de lujo en una zona exclusiva. El complejo está ubicado en Valle de los Chillos en Armenia 2, cerca de la escuela Saint Dominic. CERCA DE LAS MEJORES ESCUELAS Y SUPERMERCADOS EN UN SECTOR DE ALTA PLUSAVALIA CON ACCESO DIRECTO AL AUTOPISTA GENERAL RUMINAHUI POR EL PUENTE 8
URL de Ubicación: https://maps.app.goo.gl/BXHAHTQs9dHF2cdj8?g_st=ic
CATALOGO: https://drive.google.com/open?id=1Doqu3Z3V66yo3eKG5FtAqt4bLq0g9lpy&usp=drive_fs
*** Ya no hay departamentos disponibles en porto alegre 

****ASEGURATE ESPECIFICAR EN TU DESCRIPCION DE ESTE PROYECTO QUE HAY DEPARTAMENTOS Y CASAS 

 Propiedad Promocionada: Conjunto Villa Venetto ubicado en la mejor ubicación de Conocoto a 4 cuadras del AKI an una zona muy residencia. Son 36 departamentos con credito miti-miti (crédito VIP) de 2 dormitorios de 80m2, terraza privada de 20m2 parqueadero subterraneo desde $76,900. La primera fase está programada para entrega inmediata y la segunda fase para entrega a diciembre 2026 y la ultima fase a junio 2027, de ser el caso hay unidades que se pueden entregar antes. Todas con acabados de lujo en una zona exclusiva. 
• Nombre del proyecto: Villa Venetto • Ubicación: Conocoto, a 4 cuadras del aki , o departamento de 2 dormitorios con terraza privado de 25m², • Precio desde: 76.900 • • Financiamiento: crédito miti-miti Hasta el 95% al 4,99% de interés
 • Características clave: acabados de lujo, zona exclusiva de alta plusvalía, ASCENSOR PISCINA PET ZONE BBQ, CERCA DE supermercados 
Seguno parqueadero disponible
Link video promocional para que mandes en vez del catalgo https://drive.google.com/open?id=1LmNiGJZDRMHhiJ3byOT8ZmhAg4RWKYwm&usp=drive_fs
link paseo virtual  https://mls.kuu.la/share/collection/7TJv5?fs=1&vr=1&sd=1&initload=0&autorotate=0.16&thumbs=1&inst=es

Acabado esto trata de convencer al cliente sobre la importancia de visitar el proyecto para que conozca sus bondades y los tipos de financiamiento. Si quiere hacer una cita dile que coordinaras con un asesor para que se contacte con ella y pueda coordinar la cita.

Te dejo las Preguntas frecuentes que puedas encontrar en nuestros clientes

Que es credito vip o miti-miti es lo mimso?
Crédito VIP O miti mitien Ecuador: Vivienda propia al alcance de más familias
El Crédito VIP, o Vivienda de Interés Público, credito miti-miti es un programa del Gobierno ecuatoriano que subsidia las tasas de interés de préstamos hipotecarios para facilitar el acceso a la vivienda propia a familias de ingresos medios y bajos.
Características del Crédito miti-miti:
 * Tasa de interés fija y subsidiada: La tasa de interés actual es del 4.99% anual, la más baja para préstamos hipotecarios en el país.
 * Monto de financiamiento: Hasta el 95% del valor del avalúo comercial de la vivienda, incluidos gastos legales. En viviendas hasta $ 105.000
 * Plazo máximo: 20 años.
 * Aplica para: Viviendas nuevas que se encuentren en proyectos inmobiliarios calificados por el Ministerio de Desarrollo Urbano y Vivienda (MIT).
 * Requisitos:
   * Ser ecuatoriano o extranjero residente legal en el país.
   * No ser propietario de otra vivienda.
   * Aportar el 5% del valor de la vivienda como entrada.
   * Buena calificación crediticia, no estar en la central de riesgos
Beneficios del Crédito VIP MITI-MITI:
 * Permite acceder a una vivienda propia con una cuota mensual baja y accesible.
 * Tasa de interés fija durante todo el plazo del crédito, lo que brinda estabilidad en los pagos.
 * Posibilidad de financiar la mayor parte del costo de la vivienda, gracias al alto porcentaje de financiamiento.
 * Amplia oferta de viviendas en proyectos VIP en todo el país.
Si estás pensando en adquirir una vivienda propia, el Crédito VIP puede ser una excelente opción para 

Cuanto debo dar de entrada?

En un credito normal, los bancos financian hasta el 80% del valor del bien, y la entrada puede ser cancelada en un plan de pagos a convenir. El Biess financia hasta el 90% del valor del bien en viviendas hasta $130.000

Como gestiono mi credito?

Constructora Sarmiento rodas te ayudara en todo el tramite entregando todos los documentos listos para el credito. Trabajamos con todas las entidades financieras incluida el Biess. Trabajamos generalmente con el Banco Pichincha que tiene tasas preferenciales y el tramite es mucho mas agil.

Es muy importante que No envies varias veces el mismo mensaje
  
Recuerda que deberas distinguir entre los proyectos que ofrecen casas y departamentos 

Si un usuario te pregunta si dispones de proyectos en quito norte o cualquier otra ubicación distina al valle de los chillos o de cumbaya en quito deberas decir que por el momento no disponemos de proyectos en esa area y que solo disponemos en las ubicaciones que te acabo de dar

Si un usuario pregunta si damos financiamiento o credito directo deberas responder que no pero que trabajamos con todas las instituciones financieras incluido el biess

cuando cierres una cita notifica al vendedor llamando a la funcion sendApptNotificationToSalesMan


****NO USES WHATSAPLEAD PARA REGISTRAR UN LEAD USA SU NOMBR Y CORREO Y ESCRIBE EL PROYECTO EN E COMENTARIO




***NO OLVIDES REGISTRAR EL LEAD

UPDATE:
Cuano te pregunten por el informacion del credito MITI MITI Utiliza la misma informacion del credito vip, es lo mismo pero el gobierno ha cambiado el nombre a la iniciativa y puedes encontrar consultas con cualquiera de los dos terminos. Es importante que tambien guies a las personas y les indiques cuando te pregunten sobre este credito que se necesita:

Para un departamento
Precio desde 76.900
Entreda 5% puede pagar en cuotas hasta recibir la vivienda
95% financiamiento
ingresos minimos de 1.100 entre la persona y su conyuge y no debe de mantener deudas


Para una casa
Precio desde 105.000
Entreda 5% puede pagar en cuotas hasta recibir la vivienda
95% financiamiento
ingresos minimos de 1.800 entre la persona y su conyuge y no debe de mantener deudas

Para ser sujetos de credito en ningun caso debe de estar en central de riesgos`;

// 🔥 MIGRACIÓN: formato de tools para Responses API.
// Diferencia clave vs Assistants/Chat Completions: aquí NO se envuelve en
// { type: "function", function: {...} } — los campos van planos:
// { type: "function", name, description, parameters, strict }.
// Solo incluimos las 2 funciones CONFIRMADAS como activas y en uso real.
// appendDealChatResumen queda fuera por ahora (bug pendiente: nunca recibe
// un dealId válido porque addCustomerContactAndProjectToCRM no lo devuelve).
const TOOLS = [
    {
        type: "function",
        name: "addCustomerContactAndProjectToCRM",
        description: "Registra un lead en el CRM de Bitrix24. IMPORTANTE: Debes leer el mensaje [SYSTEM: ...] al inicio para saber si tienes o no el número del cliente.",
        strict: false,
        parameters: {
            type: "object",
            properties: {
                recipientNumber: {
                    type: "string",
                    description: "OBLIGATORIO: Número de teléfono del cliente en formato +593XXXXXXXXX. REGLAS: (1) Para WhatsApp: usa EXACTAMENTE el número que aparece en [SYSTEM: El número de teléfono de este cliente es: ...] al inicio del mensaje. COPIA Y PEGA ese número. (2) Para Messenger/Instagram: usa el número que el cliente te proporcionó después de pedírselo. IMPORTANTE: Antepón el símbolo + antes del número (ejemplo: +593984679525). NUNCA uses 593984679525 como número del cliente."
                },
                firstName: {
                    type: "string",
                    description: "Primer nombre del cliente"
                },
                lastName: {
                    type: "string",
                    description: "Apellido(s) del cliente"
                },
                email: {
                    type: "string",
                    description: "Correo electrónico del cliente (opcional, puede estar vacío si no lo proporcionó)"
                },
                projectName: {
                    type: "string",
                    description: "Nombre exacto del proyecto de interés (Porto Alegre, Belo Horizonte, etc.). NUNCA usar 'General Inquire', siempre especificar el proyecto concreto."
                },
                comments: {
                    type: "string",
                    description: "Resumen ejecutivo COMPLETO y NARRATIVO de toda la conversación. Debe incluir: cómo inició contacto, proyecto(s) mencionados, información proporcionada, si enviaste catálogo y a qué correo, preguntas sobre Crédito VIP/financiamiento, dudas sobre entrada/plazos, si quiere visitar (fecha/día), objeciones expresadas, nivel de interés (ALTO/MEDIO/BAJO), y próximos pasos. Escribe en párrafos cortos, NO uses bullets. Ejemplo: 'Cliente inició consulta sobre departamentos en Valle de los Chillos. Se le informó sobre Porto Alegre: 24 departamentos con Crédito VIP. Mostró interés en departamentos de 2 habitaciones desde $76,900. Preguntó sobre Crédito VIP - se explicó tasa 4.99% anual, financiamiento 95%, 20 años plazo. Solicitó catálogo - enviado a email@example.com. Interesado en visitar este sábado. NIVEL DE INTERÉS: ALTO. PRÓXIMOS PASOS: Coordinar visita sábado.'"
                },
                conversationHistory: {
                    type: "array",
                    items: { type: "string" },
                    description: "Array opcional con todos los mensajes intercambiados en la conversación"
                }
            },
            required: ["recipientNumber", "firstName", "lastName", "projectName"]
        }
    },
    {
        type: "function",
        name: "sendApptNotificationToSalesMan",
        description: "Notifica al vendedor cuando un cliente agenda una cita. IMPORTANTE: Debes leer el mensaje [SYSTEM: ...] al inicio para saber si tienes o no el número del cliente.",
        strict: false,
        parameters: {
            type: "object",
            properties: {
                recipientNumber: {
                    type: "string",
                    description: "OBLIGATORIO: Número de teléfono del cliente en formato +593XXXXXXXXX. REGLAS: (1) Para WhatsApp: usa EXACTAMENTE el número que aparece en [SYSTEM: El número de teléfono de este cliente es: ...] al inicio del mensaje. COPIA Y PEGA ese número, NO inventes. (2) Para Messenger/Instagram: usa el número que el cliente te proporcionó en la conversación después de que se lo pediste. NUNCA uses 593984679525 (ese es el vendedor)."
                },
                recipientName: {
                    type: "string",
                    description: "Nombre completo del cliente tal como lo proporcionó"
                },
                date: {
                    type: "string",
                    description: "Fecha de la cita (puede ser 'mañana', 'el sábado', o fecha específica como '15 de febrero')"
                },
                time: {
                    type: "string",
                    description: "Hora de la cita en formato de 12h o 24h (ejemplo: '2pm' o '14:00')"
                },
                projectName: {
                    type: "string",
                    description: "Nombre exacto del proyecto inmobiliario (Porto Alegre, Belo Horizonte, etc.)"
                }
            },
            required: ["recipientNumber", "recipientName", "date", "time", "projectName"]
        }
    }
];

// 🔥 MIGRACIÓN: loadThreadsFromFile — mantenemos el mismo archivo
// users_threads.json y la misma clave 'thread id' por compatibilidad con
// los leads ya guardados. Lo único que cambia es que ese valor ahora es
// un previous_response_id de Responses API, no un thread id de Assistants.
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
            if (user['thread id']) {
                responseIdCache.set(user['customer phone number'], user['thread id']);
            }
        });

        console.log(`✅ Loaded ${responseIdCache.size} previous_response_id(s) from file into cache`);
    } catch (error) {
        console.error('❌ Error loading threads:', error.message);
    }
}

// 🔥 MIGRACIÓN: saveThreadToFile — guarda el previous_response_id más
// reciente de cada usuario (antes guardaba el thread id de Assistants API).
async function saveThreadToFile(phoneNumber, responseId) {
    try {
        responseIdCache.set(phoneNumber, responseId);

        let usersThreads = [];
        if (fsSync.existsSync('users_threads.json')) {
            const data = await fs.readFile('users_threads.json', 'utf8');
            usersThreads = JSON.parse(data);
        }

        const existingIndex = usersThreads.findIndex(user => user['customer phone number'] === phoneNumber);

        if (existingIndex >= 0) {
            usersThreads[existingIndex]['thread id'] = responseId;
        } else {
            usersThreads.push({
                'customer phone number': phoneNumber,
                appointment_made: false,
                'thread id': responseId
            });
        }

        await fs.writeFile('users_threads.json', JSON.stringify(usersThreads, null, 2));
        console.log(`💾 Response id saved for ${phoneNumber}`);
    } catch (error) {
        console.error('❌ Error saving thread:', error.message);
    }
}

// 🔥 Inicializar cola para un usuario
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

// 🔥 Procesar cola de mensajes
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
    
    if (queue.messages.length === 0) {
        console.log(`📭 No messages in queue for ${userId}`);
        return;
    }
    
    queue.processing = true;
    queue.lastActivity = Date.now();
    
    console.log(`🔄 Processing ${queue.messages.length} messages for ${userId}`);
    
    try {
        const allMessages = queue.messages.map(m => m.text);
        const combinedMessage = allMessages.join('\n\n');
        
        console.log(`📨 Combined message from ${userId}:\n"${combinedMessage}"`);
        console.log(`📊 Total messages combined: ${allMessages.length}`);
        
        queue.messages = [];
        
        const assistantResponse = await getAssistantResponse(
            combinedMessage,
            phone_no_id,
            token,
            userId,
            platform
        );
        
        console.log(`🤖 Assistant response for ${userId}:`, assistantResponse);
        
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

// 🔥 Limpiar colas inactivas
setInterval(() => {
    const now = Date.now();
    const INACTIVE_THRESHOLD = 30 * 60 * 1000;
    
    for (const [userId, queue] of userQueues.entries()) {
        if (!queue.processing && queue.messages.length === 0) {
            if (now - queue.lastActivity > INACTIVE_THRESHOLD) {
                userQueues.delete(userId);
                if (userTimers.has(userId)) {
                    clearTimeout(userTimers.get(userId));
                    userTimers.delete(userId);
                }
                console.log(`🧹 Removed inactive queue for ${userId}`);
            }
        }
    }
}, 30 * 60 * 1000);

// 🔥 Programar procesamiento con debounce
function scheduleProcessing(userId, phone_no_id, token, platform) {
    if (userTimers.has(userId)) {
        clearTimeout(userTimers.get(userId));
        console.log(`⏰ Reset timer for ${userId} - waiting for more messages...`);
    }
    
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

// 🚨🚨🚨 FUNCIÓN DE NOTIFICACIÓN DE CITAS - CON LOGS SÚPER VISIBLES 🚨🚨🚨
const sendApptNotificationToSalesMan = async (phone_no_id, token, leadPhoneNumber, recipientName, date, time, projectName, platform = 'whatsapp') => {
    console.log('🚨🚨🚨 ============================================');
    console.log('🚨🚨🚨 APPOINTMENT NOTIFICATION FUNCTION CALLED!!!');
    console.log('🚨🚨🚨 ============================================');
    console.log('📞 Lead Phone:', leadPhoneNumber);
    console.log('👤 Lead Name:', recipientName);
    console.log('📅 Date:', date);
    console.log('⏰ Time:', time);
    console.log('🏢 Project:', projectName);
    console.log('📱 Platform:', platform);
    console.log('🚨🚨🚨 ============================================');
    
    try {
        if (leadPhoneNumber === SALES_MAN) {
            console.log('🚨🚨🚨 ERROR: Trying to use SALES_MAN number as lead!');
            return "Error interno: El sistema detectó un número de teléfono incorrecto. Por favor verifica el número del cliente.";
        }
        
        const phoneRegex = /^\+?[0-9]{10,15}$/;
        const isValidPhone = phoneRegex.test(leadPhoneNumber.replace(/\s/g, ''));
        
        if (!isValidPhone) {
            console.log('🚨 Invalid phone number format:', leadPhoneNumber);
            return "Error: El número de teléfono proporcionado no es válido. Por favor proporciona un número válido para agendar la cita.";
        }

        console.log('✅ Phone validation passed');

        if (platform === 'whatsapp' && phone_no_id) {
            console.log('📤 Preparing WhatsApp template message...');
            console.log('📤 Sending TO:', SALES_MAN);
            console.log('📤 About LEAD:', leadPhoneNumber);
            
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

            console.log('📤 Message payload prepared:', JSON.stringify(message_payload, null, 2));

            const url = `https://graph.facebook.com/v18.0/${phone_no_id}/messages`;
            const headers = {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            };
            
            console.log('🚀 SENDING NOTIFICATION TO WHATSAPP API...');
            const response = await axios.post(url, message_payload, { headers });
            console.log('✅✅✅ NOTIFICATION SENT SUCCESSFULLY!');
            console.log('📬 WhatsApp Response:', JSON.stringify(response.data, null, 2));
            
        } else if (platform === 'messenger' || platform === 'instagram') {
            console.log('📤 Messenger/Instagram: Sending notification via WhatsApp to salesman');
            
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
                console.log('✅ Notification sent via WhatsApp from', platform);
            } else {
                console.error('⚠️ WHATSAPP_PHONE_ID not configured for', platform);
            }
        }

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

        console.log('🎉🎉🎉 APPOINTMENT NOTIFICATION COMPLETED SUCCESSFULLY!');
        return "Thank you for booking the appointment. We'll get back to you soon.";

    } catch (error) {
        console.log('🚨🚨🚨 ERROR IN APPOINTMENT NOTIFICATION!!!');
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        return "Error notifying salesman";
    }
};

// 🚨🚨🚨 FUNCIÓN DE REGISTRO EN CRM - CON ASIGNACIÓN DE VENDEDOR 🚨🚨🚨
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
    console.log('🚨🚨🚨 ============================================');
    console.log('🚨🚨🚨 CRM REGISTRATION FUNCTION CALLED!!!');
    console.log('🚨🚨🚨 ============================================');
    console.log('📞 Lead Phone:', leadPhoneNumber);
    console.log('👤 Name:', firstName, lastName);
    console.log('📧 Email:', email);
    console.log('🏢 Project:', projectName);
    console.log('💬 Comments length:', comments ? comments.length : 0);
    console.log('🚨🚨🚨 ============================================');
    
    if (leadPhoneNumber === SALES_MAN) {
        console.log('🚨🚨🚨 ERROR: Trying to use SALES_MAN number as lead in CRM!');
        return "Error interno: El sistema detectó un número de teléfono incorrecto. Por favor verifica el número del cliente.";
    }
    
    console.log('✅ Using lead phone number:', leadPhoneNumber);
    
    if (!BITRIX_WEBHOOK_BASE) {
        console.log('🚨 ERROR: BITRIX_WEBHOOK_BASE not set!');
        return "Error: CRM configuration missing";
    }

    const batchUrl = `${BITRIX_WEBHOOK_BASE.replace(/\/$/, '')}/batch.json`;
    
    // 👤👤👤 ASIGNACIÓN DE VENDEDOR POR PROYECTO 👤👤👤
    // Villa Venetto → Nancy Quevedo (ID 203), siempre que el proyecto
    // incluya "Villa Venetto" — cubre casos donde el lead mencionó
    // múltiples proyectos (ej. "Porto Alegre, Villa Venetto").
    // Todos los demás proyectos → BITRIX_ASSIGNED_USER_ID (fallback '4').
    const assignedUserId = projectName.includes('Villa Venetto')
        ? '203'
        : (process.env.BITRIX_ASSIGNED_USER_ID || '4');
    console.log('👤👤👤 ============================================');
    console.log('👤 Project:', projectName);
    console.log('👤 Assigning to salesperson ID:', assignedUserId);
    console.log('👤👤👤 ============================================');
    
    const commands = {
        createContact: `crm.contact.add?FIELDS[NAME]=${encodeURIComponent('')}&FIELDS[LAST_NAME]=${encodeURIComponent(firstName + ' ' + lastName)}&FIELDS[EMAIL][0][VALUE]=${encodeURIComponent(email)}&FIELDS[EMAIL][0][VALUE_TYPE]=WORK&FIELDS[PHONE][0][VALUE]=${encodeURIComponent(leadPhoneNumber)}&FIELDS[PHONE][0][VALUE_TYPE]=WORK&FIELDS[ASSIGNED_BY_ID]=${assignedUserId}`,
        createDeal: `crm.deal.add?FIELDS[TITLE]=${encodeURIComponent('Lead - ' + firstName + ' ' + lastName)}&FIELDS[CONTACT_ID]=$result[createContact]&FIELDS[COMMENTS]=${encodeURIComponent(projectName)}&FIELDS[UF_CRM_1706240341362]=${encodeURIComponent(projectName)}&FIELDS[ASSIGNED_BY_ID]=${assignedUserId}`
    };

    if (comments) {
        const summaryText = '📋 RESUMEN DE CONVERSACIÓN:\n\n' + comments;
        commands.addSummary = `crm.timeline.comment.add?fields[ENTITY_ID]=$result[createDeal]&fields[ENTITY_TYPE]=deal&fields[COMMENT]=${encodeURIComponent(summaryText)}`;
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
        console.log('🚀 SENDING BATCH REQUEST TO BITRIX...');
        
        const response = await axios({
            method: 'POST',
            url: batchUrl,
            data: params.toString(),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        console.log('📬 Bitrix Response:', JSON.stringify(response.data, null, 2));

        if (response.data && response.data.result) {
            const dealId = response.data.result.result.createDeal;
            const contactId = response.data.result.result.createContact;
            console.log('✅✅✅ CONTACT CREATED! Contact ID:', contactId);
            console.log('✅✅✅ DEAL CREATED! Deal ID:', dealId);
            console.log('👤✅ Lead assigned to salesperson ID:', assignedUserId);
            
            console.log('🎉🎉🎉 CRM REGISTRATION COMPLETED SUCCESSFULLY!');
            return "The customer contact has been saved - don't tell the customer about that it's just for our backend";
        } else {
            console.log('🚨 Batch error - no result in response');
            return null;
        }
    } catch (error) {
        console.log('🚨🚨🚨 ERROR IN CRM REGISTRATION!!!');
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        return null;
    }
}

// =====================================================================
// 🔥 MIGRACIÓN A RESPONSES API — a partir de aquí cambia todo lo que
// antes era getOrCreateThreadId + getAssistantResponse +
// checkStatusAndPrintMessages (Assistants API).
// =====================================================================

// 🔥 MIGRACIÓN: getOrCreateThreadId -> getOrCreatePreviousResponseId
// En Assistants API, esta función creaba un "thread" vacío para encadenar
// mensajes futuros. En Responses API NO existe el concepto de thread vacío:
// el historial se encadena con el `previous_response_id` de la ÚLTIMA
// respuesta real que tuvo el usuario. Por eso, para un usuario nuevo,
// simplemente devolvemos null — la primera llamada a responses.create()
// se hará sin previous_response_id (conversación nueva).
const getOrCreatePreviousResponseId = async (phoneNumber) => {
    try {
        if (responseIdCache.has(phoneNumber)) {
            console.log('✅ Found previous_response_id in cache for:', phoneNumber);
            return responseIdCache.get(phoneNumber);
        }

        while (userLocks.get(phoneNumber)) {
            console.log('⏳ Waiting for lock to be released for:', phoneNumber);
            await delay(100);
        }

        userLocks.set(phoneNumber, true);

        try {
            if (responseIdCache.has(phoneNumber)) {
                console.log('✅ Found previous_response_id in cache (after lock) for:', phoneNumber);
                return responseIdCache.get(phoneNumber);
            }

            if (fsSync.existsSync('users_threads.json')) {
                const data = await fs.readFile('users_threads.json', 'utf8');
                const usersThreads = JSON.parse(data);

                const existingThread = usersThreads.find(user => user['customer phone number'] === phoneNumber);
                if (existingThread && existingThread['thread id']) {
                    console.log('✅ Found existing previous_response_id in file for:', phoneNumber);
                    responseIdCache.set(phoneNumber, existingThread['thread id']);
                    return existingThread['thread id'];
                }
            }

            console.log('🆕 No previous response for:', phoneNumber, '- starting new conversation');
            return null;

        } finally {
            userLocks.delete(phoneNumber);
        }

    } catch (err) {
        console.error('❌ Error in getOrCreatePreviousResponseId:', err.message);
        console.error('Stack:', err.stack);
        userLocks.delete(phoneNumber);
        return null;
    }
};

// 🔥 MIGRACIÓN: getAssistantResponse — antes: crear thread, crear mensaje,
// crear run, hacer polling de run.status. Ahora: UNA llamada a
// openai.responses.create() con instructions + input + tools +
// previous_response_id. Responses API es síncrona: no hay "status" que
// consultar con polling; la llamada devuelve directamente el resultado
// (texto final, o function_call si el modelo necesita ejecutar una función).
const getAssistantResponse = async function (prompt, phone_no_id, token, leadPhoneNumber, platform = 'whatsapp') {
    const maxRetries = 3;
    let attempt = 0;

    console.log('[getAssistantResponse] Called with leadPhoneNumber:', leadPhoneNumber);

    while (attempt < maxRetries) {
        try {
            attempt++;
            console.log(`🔄 Attempt ${attempt}/${maxRetries} for ${leadPhoneNumber}`);

            const previousResponseId = await getOrCreatePreviousResponseId(leadPhoneNumber);

            // 🔥🔥🔥 CÓDIGO MODIFICADO - INYECCIÓN EXPLÍCITA DEL NÚMERO DEL LEAD 🔥🔥🔥
            let enhancedPrompt = prompt;

            if (platform === 'whatsapp') {
                // 🔥 PARA WHATSAPP: Inyectar el número del lead explícitamente
                enhancedPrompt = `[SYSTEM: El número de teléfono de este cliente es: ${leadPhoneNumber}. 
IMPORTANTE: Cuando llames a las funciones addCustomerContactAndProjectToCRM o sendApptNotificationToSalesMan, 
USA ESTE NÚMERO como recipientNumber: ${leadPhoneNumber}
NUNCA uses 593984679525 como número del cliente, ese es el número del vendedor.]\n\n${prompt}`;

            } else if (platform === 'messenger' || platform === 'instagram') {
                // 🔥 PARA MESSENGER/INSTAGRAM: Indicar que NO tiene el número
                enhancedPrompt = `[SYSTEM: Este cliente está escribiendo desde ${platform.toUpperCase()}. 
Este es su ID de ${platform}: ${leadPhoneNumber}. 
IMPORTANTE: NO TIENES su número de teléfono todavía.
DEBES pedirle su número de celular ANTES de llamar a las funciones addCustomerContactAndProjectToCRM o sendApptNotificationToSalesMan.
Cuando te lo dé, usa ESE número como recipientNumber (ejemplo: +593984679525).
NO uses el ID ${leadPhoneNumber} como número de teléfono.]\n\n${prompt}`;
            }
            // 🔥🔥🔥 FIN DEL CÓDIGO MODIFICADO 🔥🔥🔥

            const requestParams = {
                model: OPENAI_MODEL,
                instructions: SYSTEM_INSTRUCTIONS,
                input: enhancedPrompt,
                tools: TOOLS,
            };

            // previous_response_id no se debe enviar si es null/undefined
            // (conversación nueva); solo se incluye cuando ya existe.
            if (previousResponseId) {
                requestParams.previous_response_id = previousResponseId;
            }

            console.log('📨 Calling responses.create() for', leadPhoneNumber);
            let response = await openai.responses.create(requestParams);
            console.log('✅ Response received:', response.id);

            // 🔥 Guardamos el response.id como nuevo "previous_response_id"
            // para la siguiente vez que este usuario escriba. Esto reemplaza
            // al saveThreadToFile original, que guardaba el thread id.
            await saveThreadToFile(leadPhoneNumber, response.id);

            // 🔥 MIGRACIÓN: manejo de function calls — antes esto vivía en
            // checkStatusAndPrintMessages con polling de run.status ===
            // 'requires_action'. Ahora: response.output es un array de
            // items; si el modelo quiere llamar funciones, aparecen ahí
            // como items de tipo "function_call". Las ejecutamos y
            // devolvemos los resultados en una SEGUNDA llamada a
            // responses.create(), encadenada con previous_response_id.
            const finalResponse = await handleFunctionCallsIfAny(
                response,
                phone_no_id,
                token,
                leadPhoneNumber,
                platform
            );

            return finalResponse;

        } catch (error) {
            console.error(`❌ Error in getAssistantResponse (attempt ${attempt}/${maxRetries}):`, error.message);
            console.error('Stack:', error.stack);

            if (attempt >= maxRetries) {
                return "Perdón, hubo un problema procesando tu mensaje. Por favor intenta de nuevo en un momento.";
            }

            await delay(2000 * attempt);
        }
    }

    return "Perdón, ese mensaje no llegó bien. ¿Me lo puedes repetir?";
};

// 🔥 MIGRACIÓN: reemplaza a checkStatusAndPrintMessages.
// Recibe la respuesta de responses.create() y revisa si contiene
// function_call items. Si los hay, ejecuta las funciones reales
// (addCustomerContactAndProjectToCRM, sendApptNotificationToSalesMan),
// envía los resultados de vuelta a OpenAI encadenados con
// previous_response_id, y repite hasta que el modelo entregue texto final.
// maxToolRounds evita loops infinitos si el modelo insiste en llamar
// funciones sin parar (equivalente al maxAttempts/timeout del polling viejo).
async function handleFunctionCallsIfAny(response, phone_no_id, token, leadPhoneNumber, platform) {
    const dispatchTable = {
        "addCustomerContactAndProjectToCRM": addCustomerContactAndProjectToCRM,
        "sendApptNotificationToSalesMan": sendApptNotificationToSalesMan,
    };

    let currentResponse = response;
    const maxToolRounds = 5;
    let round = 0;

    while (round < maxToolRounds) {
        const functionCalls = (currentResponse.output || []).filter(
            item => item.type === 'function_call'
        );

        if (functionCalls.length === 0) {
            // No hay más function calls: el texto final está listo.
            console.log('✅ Final response ready, no pending function calls');
            return currentResponse.output_text || "Perdón, ese mensaje no llegó bien. ¿Me lo puedes repetir?";
        }

        round++;
        console.log(`🔧🔧🔧 ROUND ${round}: ASSISTANT CALLING ${functionCalls.length} FUNCTION(S)!!!`);

        const functionOutputs = [];

        for (const call of functionCalls) {
            const funcName = call.name;
            const functionArguments = JSON.parse(call.arguments);

            console.log('🔧🔧🔧 ============================================');
            console.log('🔧 Function to execute:', funcName);
            console.log('🔧 Arguments:', JSON.stringify(functionArguments, null, 2));
            console.log('🔧🔧🔧 ============================================');

            let output;

            if (dispatchTable[funcName]) {
                console.log(`🚀 Executing function: ${funcName}`);

                try {
                    if (funcName === 'addCustomerContactAndProjectToCRM') {
                        let phoneToUse = leadPhoneNumber;

                        if (functionArguments.recipientNumber &&
                            functionArguments.recipientNumber !== leadPhoneNumber &&
                            functionArguments.recipientNumber.match(/^\+?[0-9]{10,15}$/)) {
                            phoneToUse = functionArguments.recipientNumber;
                            console.log('[addCustomer] ✅ Using phone number from assistant:', phoneToUse);
                        } else {
                            console.log('[addCustomer] ✅ Using lead phone number (message sender):', phoneToUse);
                        }

                        if (phoneToUse === SALES_MAN) {
                            console.error('[addCustomer] ❌ CRITICAL ERROR: Assistant provided SALES_MAN number!');
                            phoneToUse = leadPhoneNumber;
                        }

                        output = await addCustomerContactAndProjectToCRM(
                            phone_no_id,
                            token,
                            phoneToUse,
                            functionArguments.firstName,
                            functionArguments.lastName,
                            functionArguments.email || '',
                            functionArguments.projectName,
                            functionArguments.comments || '',
                            functionArguments.conversationHistory || []
                        );
                    } else if (funcName === 'sendApptNotificationToSalesMan') {
                        let phoneToUse = leadPhoneNumber;

                        if (functionArguments.recipientNumber &&
                            functionArguments.recipientNumber !== leadPhoneNumber &&
                            functionArguments.recipientNumber.match(/^\+?[0-9]{10,15}$/)) {
                            phoneToUse = functionArguments.recipientNumber;
                            console.log('[sendAppt] ✅ Using phone number from assistant:', phoneToUse);
                        } else {
                            console.log('[sendAppt] ✅ Using lead phone number (message sender):', phoneToUse);
                        }

                        if (phoneToUse === SALES_MAN) {
                            console.error('[sendAppt] ❌ CRITICAL ERROR: Assistant provided SALES_MAN number!');
                            phoneToUse = leadPhoneNumber;
                        }

                        output = await sendApptNotificationToSalesMan(
                            phone_no_id,
                            token,
                            phoneToUse,
                            functionArguments.recipientName,
                            functionArguments.date,
                            functionArguments.time,
                            functionArguments.projectName,
                            platform
                        );
                    }

                    console.log(`✅ Function ${funcName} completed. Output:`, output);
                } catch (error) {
                    console.error(`❌ Error executing function ${funcName}:`, error.message);
                    console.error('Stack:', error.stack);
                    output = { error: error.message };
                }
            } else {
                console.log("⚠️ Function not found:", funcName);
                output = { error: `Function ${funcName} not implemented` };
            }

            // 🔥 MIGRACIÓN: en Assistants API esto era
            // { tool_call_id: action.id, output: JSON.stringify(output) }.
            // En Responses API, el item de retorno es de tipo
            // "function_call_output" y se referencia por call_id (no por
            // tool_call_id).
            functionOutputs.push({
                type: "function_call_output",
                call_id: call.call_id,
                output: JSON.stringify(output)
            });
        }

        console.log('📤 Submitting function outputs via responses.create()...');

        // 🔥 Encadenamos con previous_response_id = currentResponse.id para
        // que el modelo "recuerde" que él mismo pidió estas funciones y
        // reciba sus resultados. No reenviamos `instructions` aquí porque
        // previous_response_id ya mantiene el contexto de esta misma cadena;
        // las instructions de nivel superior solo son necesarias en el
        // primer mensaje de cada turno de usuario (ya las mandamos arriba).
        currentResponse = await openai.responses.create({
            model: OPENAI_MODEL,
            previous_response_id: currentResponse.id,
            input: functionOutputs,
            tools: TOOLS,
        });

        // Actualizamos el cache/archivo con el id de esta nueva respuesta,
        // para que la PRÓXIMA vez que el usuario escriba, se encadene desde
        // aquí (y no se pierda el resultado de la función ya ejecutada).
        await saveThreadToFile(leadPhoneNumber, currentResponse.id);
    }

    console.error('⚠️ TIMEOUT: Exceeded maximum tool-call rounds for', leadPhoneNumber);
    return "Perdón, ese mensaje no llegó bien. ¿Me lo puedes repetir?";
}

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
                
                if (messageData.referral && messageType !== 'text') {
                    console.log('[WhatsApp] 📢 Referral detected from ad campaign');
                    console.log('[WhatsApp] 📢 Source:', messageData.referral.source_type);
                    console.log('[WhatsApp] 📢 Ad body:', messageData.referral.body);
                    
                    if (processedMessages.has(wamid)) {
                        console.log('[WhatsApp] ⚠️ Duplicate referral message, ignoring:', wamid);
                        return res.sendStatus(200);
                    }
                    processedMessages.add(wamid);
                    
                    console.log('[WhatsApp] 📨 Referral message from LEAD:', from);
                    
                    initializeQueue(from);
                    
                    const referralText = messageData.referral.body || "Hola, quiero más información del proyecto Porto Alegre";
                    userQueues.get(from).messages.push({ text: referralText });
                    
                    console.log(`📥 Referral message added to queue for LEAD ${from}`);
                    
                    res.sendStatus(200);
                    
                    scheduleProcessing(from, phone_no_id, token, 'whatsapp');
                    
                    return;
                }
                
                if (messageType !== 'text') {
                    console.log(`[WhatsApp] ⚠️ Ignoring non-text message type: ${messageType}`);
                    return res.sendStatus(200);
                }
                
                let msg_body = messageData.text.body;

                if (processedMessages.has(wamid)) {
                    console.log('[WhatsApp] ⚠️ Duplicate message detected, ignoring:', wamid);
                    return res.sendStatus(200);
                }
                processedMessages.add(wamid);

                console.log('[WhatsApp] 📨 Message received from LEAD:', from);
                console.log('[WhatsApp] 💬 Message body:', msg_body);

                if (from == FOLLOWUP_MESSAGES_TRIGGER_NUMBER) {
                    if (msg_body == FOLLOWUP_MESSAGES_TRIGGER_COMMAND) {
                        const followUpFunctionResponse = await followUpFunction(phone_no_id, token);
                        console.log(followUpFunctionResponse);
                    } else {
                        console.log(`Please select the right command to trigger the follow-up: "${FOLLOWUP_MESSAGES_TRIGGER_COMMAND}"`);
                    }
                    return res.sendStatus(200);
                }

                initializeQueue(from);
                userQueues.get(from).messages.push({ text: msg_body });
                
                console.log(`📥 Message added to queue for LEAD ${from}. Queue size: ${userQueues.get(from).messages.length}`);
                
                res.sendStatus(200);
                
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

                if (processedMessages.has(mid)) {
                    console.log(`[${platform}] ⚠️ Duplicate message detected, ignoring:`, mid);
                    return res.sendStatus(200);
                }
                processedMessages.add(mid);

                console.log(`[${platform}] 📨 Message received from LEAD ID:`, senderId);
                console.log(`[${platform}] 💬 Message body:`, messageText);

                initializeQueue(senderId);
                userQueues.get(senderId).messages.push({ text: messageText });
                
                console.log(`📥 Message added to queue for ${senderId}. Queue size: ${userQueues.get(senderId).messages.length}`);
                
                res.sendStatus(200);
                
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
        threads: responseIdCache.size
    });
});
