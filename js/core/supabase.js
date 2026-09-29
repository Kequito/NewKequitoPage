/* Conexión a Supabase (REST): configuración y helpers de lectura/escritura compartidos por todas las vistas. */

/* ══════════════════════════════
   SUPABASE CONFIG
══════════════════════════════ */
const SB_URL  = 'https://nxxwwkseelvxrwqjqmip.supabase.co';
const SB_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im54eHd3a3NlZWx2eHJ3cWpxbWlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMTE3MDIsImV4cCI6MjA5MDc4NzcwMn0.q69eyOHcADsr6-hMAesw4xBBRtdoTD1AkJ3VThB-iDM';
const SB_HEADERS = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` };

/* Token de sesión: viaja en cada consulta como "x-session-token" y Supabase lo usa en las
   políticas RLS (app_role()) para saber el cargo REAL de quien consulta — ver supabase/01_sesiones.sql.
   SB_HEADERS se modifica a propósito: todas las llamadas usan SB_HEADERS / {...SB_HEADERS}
   en el momento de pedir, así que toman siempre el token vigente. */
function sbSetSessionToken(token) {
  if (token) SB_HEADERS['x-session-token'] = token;
  else delete SB_HEADERS['x-session-token'];
}

/* Llama a una función de Supabase (rpc). Si falla, lanza un Error con el mensaje
   legible de Postgres (ej. "Solo un Supervisor puede crear cuentas"). */
async function sbRpc(fn, params = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error((data && data.message) || `Error ${res.status} en ${fn}`);
  return data;
}

async function sbFetch(table, params = '') {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, { headers: SB_HEADERS });
  if (!res.ok) throw new Error(`Supabase error ${res.status}`);
  return res.json();
}

/* ── Supabase write helper (GET ya existe via sbFetch) ── */
async function sbInsert(table, payload) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Supabase insert error ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return res.json();
}

async function bulkInsert(table, rows) {
  const chunkSize = 500;
  for (let i = 0; i < rows.length; i += chunkSize) {
    await sbInsert(table, rows.slice(i, i + chunkSize));
  }
}
