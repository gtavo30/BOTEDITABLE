// bitrixWebhookClient.js
// Cliente mínimo para llamar al webhook global de Bitrix (batch.json)
// SIN modificar la lógica del bot ni el flujo existente.
// Usa la env var acordada: BITRIX_WEBHOOK_BASE
//
// Requisitos: Node 18+ (fetch nativo). Si usas <18, instala node-fetch y ajusta el fetch.

const BASE = process.env.BITRIX_WEBHOOK_BASE; // p.ej. https://tudominio.bitrix24.es/rest/1/<token>

if (!BASE) {
  console.warn('[bitrixWebhookClient] Falta BITRIX_WEBHOOK_BASE en el entorno.');
}

/**
 * Normaliza el texto para un campo string (ROWS=1) y acota tamaño.
 * - Reemplaza saltos de línea por " · " para una visualización estable en Bitrix.
 * - Trunca a ~7000 caracteres por acuerdo.
 */
function normalizeResumen(text, max = 7000) {
  if (typeof text !== 'string') return '';
  const oneLine = text.replace(/\r?\n/g, ' · ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

/**
 * Construye el cuerpo x-www-form-urlencoded para batch.json
 */
function buildBatchBody(cmd) {
  const params = new URLSearchParams();
  params.set('halt', '0'); // no detener en primer error
  for (const [k, v] of Object.entries(cmd)) {
    params.set(`cmd[${k}]`, v);
  }
  return params;
}

/**
 * Llama batch.json de Bitrix con POST application/x-www-form-urlencoded
 */
async function callBatch(cmd) {
  if (!BASE) {
    return { ok: false, error: 'BITRIX_WEBHOOK_BASE not set', data: null };
  }
  const url = `${BASE.replace(/\/$/, '')}/batch.json`;
  const body = buildBatchBody(cmd);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  let data = null;
  try { data = await res.json(); } catch (e) { data = {}; }

  if (!res.ok || (data && data.error)) {
    return {
      ok: false,
      error: (data && (data.error_description || data.error)) || `HTTP_${res.status}`,
      data,
    };
  }
  return { ok: true, error: null, data };
}

/**
 * Guarda el resumen de chat en el Deal (UF_CRM_1757716806 = "chat (Resumen)").
 * NO toca lógica del bot: es una función utilitaria para tu tool.
 *
 * @param {string|number} dealId - ID del Deal en Bitrix (ej. 44077)
 * @param {string} chatResumen - Texto plano del resumen (se normaliza a 1 línea)
 */
async function appendDealChatResumen(dealId, chatResumen) {
  const id = String(dealId || '').trim();
  if (!id) return { ok: false, error: 'dealId_required', data: null };

  const normalized = normalizeResumen(chatResumen);

  const q = new URLSearchParams();
  q.set('ID', id);
  q.set('fields[UF_CRM_1757716806]', normalized);

  const cmd = { updateResumen: `crm.deal.update?${q.toString()}` };
  return callBatch(cmd);
}

module.exports = {
  appendDealChatResumen,
  _internal: { normalizeResumen, buildBatchBody, callBatch }, // opcional para test
};
