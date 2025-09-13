# bitrixWebhookClient (drop-in)

**Objetivo:** guardar el resumen de conversación en Bitrix **sin tocar la lógica del bot**, usando tu **webhook global** y la env var **BITRIX_WEBHOOK_BASE**.

- Campo de destino: `UF_CRM_1757716806` = **chat (Resumen)** (string, 1 línea).
- Método: `crm.deal.update` dentro de `batch.json`.
- Requisitos: Node 18+ (fetch nativo).

## Instalación

Copia `bitrixWebhookClient.js` a tu proyecto (por ejemplo `./lib/bitrixWebhookClient.js`).  
Asegúrate de tener `BITRIX_WEBHOOK_BASE` en las variables de entorno (mismo nombre que ya usas).

## Uso (CommonJS)

```js
const { appendDealChatResumen } = require('./lib/bitrixWebhookClient');

// En el handler de tu tool (sin cambiar tu flujo):
async function onAppendDealChatResumen({ dealId, chatResumen }) {
  return await appendDealChatResumen(dealId, chatResumen);
}
```

## Prueba manual (opcional)

```bash
node -e "require('./lib/bitrixWebhookClient').appendDealChatResumen(44077, 'Prueba QA · línea única').then(console.log)"
```

## Notas

- Se normalizan saltos de línea a ` · ` y se trunca a ~7000 caracteres para estabilidad del campo de una línea.
- No se modifica ninguna otra parte del bot.
- `BITRIX_WEBHOOK_BASE` debe apuntar a tu webhook global (`.../rest/1/<token>`). `batch.json` soporta incluir `crm.deal.update`.
