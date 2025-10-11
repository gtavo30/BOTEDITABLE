// bitrixWebhookClient.js
const BASE = process.env.BITRIX_WEBHOOK_BASE;

if (!BASE) {
  console.warn('[bitrixWebhookClient] Falta BITRIX_WEBHOOK_BASE en el entorno.');
}

function normalizeResumen(text, max = 7000) {
  if (typeof text !== 'string') return '';
  const oneLine = text.replace(/\r?\n/g, ' · ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

function buildBatchBody(cmd) {
  const params = new URLSearchParams();
  params.set('halt', '0');
  for (const [k, v] of Object.entries(cmd)) {
    params.set(`cmd[${k}]`, v);
  }
  return params;
}

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
  _internal: { normalizeResumen, buildBatchBody, callBatch },
};
