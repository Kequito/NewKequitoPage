/* Asistencia en vivo — hoja de Google publicada (mismo formato que la distribución de GoodDay:
   TEAMLEADER, ASESORES, PEROP1AM, …, ASISTENCIA). La usan:
   · GoodDay: llena la columna "Asistencia".
   · Stats OPs Live: solo muestra los OPs marcados con "A".
   Se guarda en memoria 1 minuto para no descargarla dos veces seguidas entre secciones.
   El link se cambia en "Actualización de Data" (dt_data_links, clave att_sheet); si no hay uno guardado,
   se usa el de por defecto. */

const ATT_LINK_KEY = 'att_sheet';
const ATT_DEFAULT_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRRnYzQDXLLCJm_-KROaAtOHkItwAJOo9nDzyzr7L1EFgAiN0exuepzVugqkOmNf7CnvM7JJyQ-Qccy/pubhtml?gid=0&single=true';
function attSheetUrl() { return sheetSavedUrl(ATT_LINK_KEY, ATT_DEFAULT_URL); }
function attOnLinkChanged(sectionKey) { if (sectionKey === ATT_LINK_KEY) attCache = null; }
const ATT_CACHE_MS = 60 * 1000;

let attCache = null;   // { map: Map(número → código), fetchedAt, total }
let attPending = null; // descarga en curso (para que dos secciones no la pidan a la vez)

/* Devuelve { map, fetchedAt, total }. force = ignorar la memoria de 1 minuto (botón "Actualizar", auto-refresh). */
async function attFetch(force = false) {
  if (!force && attCache && Date.now() - attCache.fetchedAt < ATT_CACHE_MS) return attCache;
  if (attPending) return attPending;
  attPending = (async () => {
    await sheetLoadLinks([ATT_LINK_KEY]);
    const table = await sheetFetchCsv(sheetCsvUrl(attSheetUrl()), 'asistencia');
    if (!table.length) throw new Error('La hoja de asistencia llegó vacía.');
    const header = table[0];
    const cOp = sheetColumn(header, 'PEROP1AM');
    const cAtt = sheetColumn(header, 'ASISTENCIA');
    if (cOp < 0 || cAtt < 0) throw new Error('La hoja de asistencia no tiene las columnas PEROP1AM y ASISTENCIA. ¿Cambió el formato?');
    const map = new Map();
    table.slice(1).forEach(r => {
      const num = sheetOperatorNumber(r[cOp]);
      if (num && !map.has(num)) map.set(num, String(r[cAtt] ?? '').trim());
    });
    attCache = { map, fetchedAt: Date.now(), total: map.size };
    return attCache;
  })();
  try { return await attPending; } finally { attPending = null; }
}

/* Códigos de la hoja de asistencia (confirmados con el equipo). La clave va en mayúsculas;
   el código se muestra tal cual viene en la hoja. Un código nuevo que no esté aquí sale en ámbar. */
const ATT_CODES = {
  A:   { label: 'Asistió',                  cls: 'att-a' },
  FA:  { label: 'Falta',                    cls: 'att-fa' },
  S:   { label: 'Suspensión',               cls: 'att-s' },
  OFF: { label: 'Descanso',                 cls: 'att-off' },
  VA:  { label: 'Vacaciones',               cls: 'att-off' },
  DM:  { label: 'Descanso médico',          cls: 'att-off' },
  B:   { label: 'Baja (ya no continúa)',    cls: 'att-baja' },
};

/* ¿Asistió? — solo "A" (sin importar mayúsculas/espacios) */
function attIsPresent(code) { return String(code ?? '').trim().toUpperCase() === 'A'; }

/* Significado de un código ("OFF" → "Descanso"), o '' si es desconocido */
function attMeaning(code) {
  const info = ATT_CODES[String(code ?? '').trim().toUpperCase()];
  return info ? info.label : '';
}

/* Badge con el código tal cual viene en la hoja; el significado va en el tooltip */
function attBadge(code) {
  const c = String(code ?? '').trim();
  if (!c) return `<span class="att-badge att-empty" title="Todavía sin marcar en la hoja de asistencia">Sin marcar</span>`;
  const info = ATT_CODES[c.toUpperCase()];
  const title = info ? `${c} — ${info.label}` : `Código de asistencia: ${c}`;
  return `<span class="att-badge ${info ? info.cls : 'att-other'}" title="${escapeHtml(title)}">${escapeHtml(c)}</span>`;
}

/* Leyenda de códigos (se muestra en GoodDay) */
function attLegendHTML() {
  return '<span class="att-legend-title">Asistencia:</span>' + Object.entries(ATT_CODES).map(([code, info]) =>
    `<span class="att-legend-item"><span class="att-badge ${info.cls}">${code === 'FA' ? 'Fa' : code}</span>${escapeHtml(info.label)}</span>`
  ).join('') + '<span class="att-legend-item"><span class="att-badge att-empty">Sin marcar</span>todavía no registrado</span>';
}
