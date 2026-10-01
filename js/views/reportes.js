/* Vista Reporte — 4 fuentes pegadas por separado, una tabla ancha tipo imagen y la evolución del % Approve.

   Cada fuente se pega y se guarda SOLA; las demás se quedan con lo último guardado:
     ① Leads & Approve (panel de ventas) → dt_reportes_ventas (snapshots + gráfica de evolución, como siempre)
     ② Check — Avg Price por país        → dt_reportes_extra, section = 'check'
     ③ T.Wait por país                   → dt_reportes_extra, section = 'wait'   (supabase/04_reporte_extra.sql)
     ④ Operational Coverage              → dt_leads_campana, la MISMA tabla de "Leads por Campaña"
        (pegar aquí actualiza también esa sección, con su mismo bloqueo de 2 min — leadsSubmitPaste)
   La tabla se puede descargar o copiar como imagen (html2canvas, se carga solo al usarlo). */

/* ══════════════════════════════
   REPORTES — configuración compartida (la usan también Inicio, Leads, Approve Stats, Top TL)
══════════════════════════════ */
const REP_COLS = ['num','name','primaryQueue','country','total','new','recall','noAnswer','approved','reject','trash','duplicate','systemTrash','technicalAttempt'];

// Colores categóricos validados (orden fijo, no ciclado) — dataviz skill, paso dark
const REP_COUNTRY_COLORS = {
  'Mexico':     '#3987e5',
  'Colombia':   '#d95926',
  'Chile':      '#199e70',
  'Peru':       '#c98500',
  'Costa Rica': '#d55181',
  'Paraguay':   '#008300',
  'Ecuador':    '#9085e9',
  'Uruguay':    '#e66767',
};
const REP_FALLBACK_COLORS = ['#7c8a82', '#94a3b8', '#a8a29e'];

let repHistory   = [];
let repLoaded    = false;
let repChartInstance = null;
// Techo por defecto del eje Y — 100% es correcto pero poco realista de ver.
// Sube esto a 100 el día que alguna estadística lo necesite de forma habitual.
const REP_CHART_MAX_DEFAULT = 75;

// Proporción de trabajo: 1 OP por cada 30 leads disponibles → "OPs +/-" = redondear(disponibles ÷ 30) − OPs online
const REP_LEADS_PER_OP = 30;

/* Estado actual del reporte (lo último guardado de cada fuente) */
let repByCountry    = [];     // ① by_country del último snapshot, con deltas vs el anterior
let repGlobal       = { total: 0, approved: 0, approvePct: 0 };
let repPrevSnapshot = null;   // ① snapshot anterior (para deltas y el resumen)
let repLatestApprove = null;  // ① último snapshot { created_at, created_by, ... }
let repExtra        = { check: null, wait: null }; // ②③ última fila de dt_reportes_extra de cada una
let repCoverageRow  = null;   // ④ última fila de dt_leads_campana

/* Fuentes de datos — una pestaña de pegado por cada una.
   linkKey = su link de "Data" en dt_data_links (el de ④ es el MISMO de Leads por Campaña: misma fuente). */
const REP_SOURCES = [
  { key: 'approve',  num: 1, label: 'Leads & Approve', perm: 'reportes.save', linkKey: 'rep_approve',
    placeholder: 'Pega aquí el bloque completo copiado del Panel de ventas (incluye el encabezado #, Name, Primary queue...)' },
  { key: 'check',    num: 2, label: 'Check (Avg Price)', perm: 'reportes.save', linkKey: 'rep_check',
    placeholder: 'Pega aquí el bloque del Check por país, con sus 2 filas de encabezado (Country, Total, By lead statuses, Avg Price...)' },
  { key: 'wait',     num: 3, label: 'T.Wait', perm: 'reportes.save', linkKey: 'rep_wait',
    placeholder: 'Pega aquí el bloque de tiempos por país, con encabezado (Country (Event), Event Period, Total time, ..., Wait)' },
  { key: 'coverage', num: 4, label: 'Operational Coverage', perm: 'leads.save', linkKey: 'leads',
    placeholder: 'Pega aquí el bloque del Panel de colas — el mismo de Leads por Campaña (Country, Name, Number of operators, Capacity, Orders...)',
    note: 'Esto también actualiza "Leads por Campaña" (misma data, mismo bloqueo de 2 minutos).' },
];

function repTogglePaste() {
  const body = document.getElementById('rep-paste-body');
  const chevron = document.getElementById('rep-paste-chevron');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  chevron.style.transform = open ? 'rotate(-90deg)' : 'rotate(0deg)';
}

/* ══════════════════════════════
   ① LEADS & APPROVE — panel de ventas
══════════════════════════════ */
function repParsePanelData(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const cells = line.split('\t').length > 1 ? line.split('\t') : line.split(/\s{2,}/);
    if (cells.length < 5) continue;
    if (/^#$/.test(cells[0].trim()) || /name/i.test(cells[1] || '')) continue;
    const num = cells[0] ? cells[0].trim() : '';
    if (!num || isNaN(Number(num))) continue;
    const row = {};
    REP_COLS.forEach((key, i) => {
      const v = cells[i] !== undefined ? cells[i].trim() : '';
      if (['name', 'primaryQueue', 'country'].includes(key)) {
        row[key] = v;
      } else {
        const n = parseInt(v.replace(/[^\d-]/g, ''), 10);
        row[key] = isNaN(n) ? 0 : n;
      }
    });
    rows.push(row);
  }
  return rows;
}

function repAggregateByCountry(rows) {
  const map = {};
  rows.forEach(r => {
    if (!map[r.country]) {
      map[r.country] = { country: r.country, total:0, new:0, recall:0, noAnswer:0, approved:0, reject:0, trash:0, duplicate:0, systemTrash:0, technicalAttempt:0 };
    }
    const c = map[r.country];
    c.total += r.total; c.new += r.new; c.recall += r.recall; c.noAnswer += r.noAnswer;
    c.approved += r.approved; c.reject += r.reject; c.trash += r.trash;
    c.duplicate += r.duplicate; c.systemTrash += r.systemTrash; c.technicalAttempt += r.technicalAttempt;
  });
  return Object.values(map)
    .map(c => ({ ...c, approvePct: c.total > 0 ? (c.approved / c.total) * 100 : 0 }))
    .sort((a, b) => b.total - a.total);
}

function repGetGlobal(rows) {
  const total = rows.reduce((s, r) => s + r.total, 0);
  const approved = rows.reduce((s, r) => s + r.approved, 0);
  return { total, approved, approvePct: total > 0 ? (approved / total) * 100 : 0 };
}

function repApproveClass(pct) {
  if (pct < 25) return 'rep-approve-bad';
  if (pct < 30) return 'rep-approve-mid';
  return 'rep-approve-good';
}

function repFmtPct(n) { return `${n.toFixed(1)}%`; }

/* ══════════════════════════════
   ② CHECK — Avg Price por país
   Formato (tab-separado, 2 filas de encabezado):
     Country | Total | New n % | Recall n % | No answer n % | Approve n % | Reject n % | Trash n % | Avg Price | | Approved Income | (Creation…)
   Se toma el PRIMER "Avg Price" (el que va después de Trash), no el del bloque "Creation".
══════════════════════════════ */

/* "$74,22" / "$1.234,56" / "$74.22" / "$1,234.56" → número (o null) */
function repParseMoney(value) {
  let s = String(value ?? '').replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const commas = (s.match(/,/g) || []).length;
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (commas > 1) {
    s = s.replace(/,/g, '');          // "1,234,567" → miles
  } else if (commas === 1) {
    s = s.replace(',', '.');          // "74,22" → decimal con coma (formato del panel)
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function repIntCell(value) {
  const n = parseInt(String(value ?? '').replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/* Filas de país de un bloque pegado: primera celda con texto (sin números) y no un encabezado */
function repIsCountryCell(cell) {
  const c = String(cell || '').trim();
  return !!c && !/\d/.test(c) && !/^(country|pa[ií]s)\b/i.test(c) && !/total/i.test(c);
}

function repSplitLines(raw) {
  return String(raw || '').split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim() !== '');
}

function repParseCheck(raw) {
  const byKey = new Map();
  repSplitLines(raw).forEach(line => {
    const cells = line.split('\t').map(c => c.trim());
    if (!repIsCountryCell(cells[0])) return;
    const total = repIntCell(cells[1]);
    if (total === null) return;
    const priceIdx = cells.findIndex((c, i) => i > 1 && c.includes('$'));
    if (priceIdx === -1) return;
    const avgPrice = repParseMoney(cells[priceIdx]);
    const approve = repIntCell(cells[8]) || 0;                    // "Approve" del bloque de estados
    const k = repCountryKey(cells[0]);
    // Si un país viniera repetido, se queda la fila con más leads
    const prev = byKey.get(k);
    if (!prev || total > prev.total) byKey.set(k, { country: cells[0], total, approve, avgPrice });
  });

  const byCountry = [...byKey.values()];
  // Promedio correcto del total: ponderado por approves (= ingreso total ÷ approves totales).
  // Si todavía no hay approves, promedio simple de los países con precio.
  const priced = byCountry.filter(c => c.avgPrice !== null && c.avgPrice > 0);
  const approves = priced.reduce((s, c) => s + c.approve, 0);
  let avgPrice = null, method = null;
  if (approves > 0) {
    avgPrice = priced.reduce((s, c) => s + c.avgPrice * c.approve, 0) / approves;
    method = 'weighted';
  } else if (priced.length > 0) {
    avgPrice = priced.reduce((s, c) => s + c.avgPrice, 0) / priced.length;
    method = 'simple';
  }
  return { byCountry, global: { avgPrice, approve: approves, method } };
}

function repFmtMoney(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/* ══════════════════════════════
   ③ T.WAIT — tiempo Wait por país
   Formato: Country (Event) | Event Period | Total time | Calls count | Ready | Online | Call | Save | View order | Wait | Avg calls…
   La fila de totales (sin país) y el "5,0" que baja a otra línea se ignoran solos.
══════════════════════════════ */
function repParseDuration(value) {
  const m = String(value ?? '').trim().match(/^(\d+):(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function repFmtDuration(sec) {
  if (sec === null || sec === undefined || !Number.isFinite(Number(sec))) return '—';
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function repParseWait(raw) {
  const lines = repSplitLines(raw);
  let waitIdx = 9;
  const header = lines.find(l => /country/i.test(l) && /\bwait\b/i.test(l));
  if (header) {
    const i = header.split('\t').findIndex(c => c.trim().toLowerCase() === 'wait');
    if (i >= 0) waitIdx = i;
  }
  const byKey = new Map();
  lines.forEach(line => {
    const cells = line.split('\t').map(c => c.trim());
    if (!repIsCountryCell(cells[0])) return;
    const sec = repParseDuration(cells[waitIdx]);
    if (sec === null) return;
    const k = repCountryKey(cells[0]);
    // Varios días del mismo país (rango de fechas) → se suman
    const prev = byKey.get(k);
    if (prev) prev.waitSec += sec;
    else byKey.set(k, { country: cells[0], waitSec: sec });
  });
  const byCountry = [...byKey.values()];
  return { byCountry, global: { waitSec: byCountry.reduce((s, c) => s + c.waitSec, 0) } };
}

/* ══════════════════════════════
   ④ OPERATIONAL COVERAGE — sale de la última fila de dt_leads_campana
══════════════════════════════ */
function repCoverageFor(c) {
  const queues = [...(c.queues || [])].sort((a, b) => leadsQueueSortKey(a.name) - leadsQueueSortKey(b.name));
  // Cada fila cuenta los OPs que la tienen ACTIVADA, y un mismo OP suele tener varias filas a la vez
  // (6 · 6 · 6 = 6 OPs, no 18). Por eso no se suman: se toma la fila con más OPs.
  const opsOnline = queues.reduce((max, q) => Math.max(max, Number(q.ops) || 0), 0);
  const available = Number(c.sumOrders) || 0;
  // Cola actual: la primera (1-1, 2-2, 3-3…) que todavía no está en rojo (≥ 3 leads disponibles)
  const current = queues.find(q => (Number(q.orders) || 0) >= LEADS_LOW_ORDERS_THRESHOLD);
  return {
    available,
    totalOrders: Number(c.sumTotalOrders) || 0,
    opsOnline,
    opsDelta: Math.round(available / REP_LEADS_PER_OP) - opsOnline,
    currentQueue: current ? current.name : null,
  };
}

/* ══════════════════════════════
   GUARDADO — cada fuente por separado
══════════════════════════════ */

/* Guarda una fuente ①②③. Devuelve un mensaje de error (texto) o null si salió bien. */
async function repSaveSourceData(key, raw) {
  const user = getCurrentUser();
  const by = user ? user[0] : null;

  if (key === 'approve') {
    const rows = repParsePanelData(raw);
    if (rows.length === 0) return 'No pude reconocer filas válidas. Verifica que hayas pegado el bloque completo copiado del Panel (incluyendo encabezado).';
    await sbInsert('dt_reportes_ventas', [{
      created_by: by, rows, by_country: repAggregateByCountry(rows), global: repGetGlobal(rows),
    }]);
    return null;
  }

  const parsed = key === 'check' ? repParseCheck(raw) : repParseWait(raw);
  if (parsed.byCountry.length === 0) {
    return key === 'check'
      ? 'No reconocí ningún país con su Avg Price. Pega el bloque completo, con los países en la primera columna y el precio con "$".'
      : 'No reconocí ningún país con su tiempo Wait (formato h:mm:ss). Pega el bloque completo con su encabezado.';
  }
  await sbInsert('dt_reportes_extra', [{ section: key, by_country: parsed.byCountry, global: parsed.global, created_by: by }]);
  return null;
}

async function repSaveSource(key) {
  const src = REP_SOURCES.find(s => s.key === key);
  if (!src || !can(src.perm)) return;
  const input = document.getElementById(`rep-src-input-${key}`);
  const errBox = document.getElementById(`rep-src-error-${key}`);
  const status = document.getElementById(`rep-src-status-${key}`);
  const btn = document.getElementById(`rep-src-btn-${key}`);
  errBox.style.display = 'none';
  status.textContent = '';

  const raw = input.value;
  if (!raw.trim()) {
    errBox.textContent = 'Pega los datos primero.';
    errBox.style.display = 'flex';
    return;
  }

  btn.disabled = true;
  status.style.color = 'var(--text-light)';
  status.textContent = 'Guardando...';
  try {
    let error = null, cooldown = false;
    if (key === 'coverage') {
      const res = await leadsSubmitPaste(raw);   // guarda en dt_leads_campana y refresca Leads por Campaña
      error = res.error || null;
      cooldown = !!res.cooldown;
    } else {
      error = await repSaveSourceData(key, raw);
    }

    if (error) {
      status.textContent = '';
      if (cooldown) {
        status.style.color = 'var(--amber)';
        status.textContent = error;
      } else {
        errBox.textContent = error;
        errBox.style.display = 'flex';
        btn.disabled = false;
      }
      return;
    }

    input.value = '';
    status.style.color = 'var(--green)';
    status.textContent = '✓ Guardado — ya se ve así para todos';
    setTimeout(() => { status.textContent = ''; }, 6000);
    if (key !== 'coverage') btn.disabled = false;   // el de cobertura queda con el bloqueo de 2 min
    await repLoadCurrentReport(true);
    if (key === 'approve') repLoadHistory();
  } catch (err) {
    console.error(`Error guardando la fuente "${key}" de Reporte:`, err);
    status.style.color = 'var(--red)';
    status.textContent = (err && err.message) ? err.message : 'No se pudo guardar, intenta de nuevo.';
    status.title = status.textContent;
    btn.disabled = false;
  }
}

/* Pestañas de pegado — solo las fuentes que esta cuenta puede actualizar */
function repRenderSourceForms() {
  const allowed = REP_SOURCES.filter(s => can(s.perm));
  const tabs = document.getElementById('rep-src-tabs');
  const panes = document.getElementById('rep-src-panes');
  tabs.innerHTML = allowed.map(s => `
    <button type="button" class="btn btn-sm btn-ghost rep-src-tab" data-src="${s.key}" role="tab" onclick="repSelectSource('${s.key}')">
      <span class="rep-src-num rep-src-num-${s.num}">${s.num}</span>${s.label}
      <span class="rep-src-tab-time" id="rep-src-tabtime-${s.key}"></span>
    </button>`).join('');
  panes.innerHTML = allowed.map(s => `
    <div class="rep-src-pane" data-src="${s.key}" role="tabpanel" hidden>
      <div class="rep-src-linkrow">
        <span class="caps-label">Fuente</span>
        <a id="rep-src-link-${s.key}" class="btn btn-ghost btn-sm no-underline" href="#" target="_blank" rel="noopener"
          onclick="return repOpenDataLink(event, '${s.key}')" title="Abrir de dónde se copia esta data, en una pestaña nueva">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7zM5 5h5V3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-5h-2v5H5V5z"/></svg>
          Abrir Data
        </a>
        <button id="rep-src-linkedit-${s.key}" class="btn btn-ghost btn-sm" type="button" style="display:none"
          onclick="repEditDataLink('${s.key}')" title="Cambiar el link de esta fuente">✎</button>
        <span id="rep-src-lastinfo-${s.key}" class="rep-src-hint rep-src-lastinfo"></span>
      </div>
      <textarea id="rep-src-input-${s.key}" class="paste-area" placeholder="${escapeHtml(s.placeholder)}"></textarea>
      <div id="rep-src-error-${s.key}" class="form-error" style="display:none"></div>
      <div class="actions-row">
        <button class="btn btn-primary" id="rep-src-btn-${s.key}" type="button" onclick="repSaveSource('${s.key}')">Guardar y actualizar</button>
        <span id="rep-src-status-${s.key}" class="fs12-600"></span>
        ${s.key === 'coverage' ? '<span id="rep-src-cooldown-coverage" class="rep-src-hint"></span>' : ''}
      </div>
      ${s.note ? `<div class="rep-src-hint">${escapeHtml(s.note)}</div>` : ''}
    </div>`).join('');
  if (allowed.length) repSelectSource(allowed[0].key);
  repRenderDataLinks();
}

/* ── Link de "Data" de cada fuente (dt_data_links) — cualquiera lo abre, solo "datalinks.edit" lo cambia ── */
async function repFetchDataLinks() {
  try {
    const keys = REP_SOURCES.map(s => s.linkKey).join(',');
    const rows = await sbFetch('dt_data_links', `select=*&section_key=in.(${keys})`);
    REP_SOURCES.forEach(s => { delete dataLinksMap[s.linkKey]; });
    (rows || []).forEach(r => { dataLinksMap[r.section_key] = r; });
  } catch (err) {
    console.error('Error cargando los links de Data de Reporte:', err);
  }
}

function repRenderDataLinks() {
  REP_SOURCES.forEach(s => {
    const a = document.getElementById(`rep-src-link-${s.key}`);
    const edit = document.getElementById(`rep-src-linkedit-${s.key}`);
    if (!a || !edit) return;
    const link = dataLinksMap[s.linkKey];
    a.href = safeUrl(link && link.url);
    a.classList.toggle('rep-src-link-missing', !(link && link.url));
    edit.style.display = can('datalinks.edit') ? 'inline-flex' : 'none';
  });
}

function repOpenDataLink(event, key) {
  const src = REP_SOURCES.find(s => s.key === key);
  const link = src && dataLinksMap[src.linkKey];
  if (link && link.url) return true;   // el <a target="_blank"> lo abre normalmente
  event.preventDefault();
  if (can('datalinks.edit')) repEditDataLink(key);
  else uiAlert('Aún no se ha configurado el link de esta fuente — pide a quien gestiona los links de Data que lo configure.', { title: 'Sin link de Data' });
  return false;
}

async function repEditDataLink(key) {
  const src = REP_SOURCES.find(s => s.key === key);
  if (!src || !can('datalinks.edit')) return;
  await dataLinkEdit(src.linkKey, src.key === 'coverage' ? 'Leads por Campaña / Operational Coverage' : `Reporte — ${src.label}`);
  repRenderDataLinks();
  if (src.linkKey === 'leads' && typeof leadsRenderDataLinkBtn === 'function') leadsRenderDataLinkBtn();
}

function repSelectSource(key) {
  document.querySelectorAll('.rep-src-tab').forEach(b => {
    const on = b.dataset.src === key;
    b.classList.toggle('btn-primary', on);
    b.classList.toggle('btn-ghost', !on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.rep-src-pane').forEach(p => { p.hidden = p.dataset.src !== key; });
}

/* ══════════════════════════════
   CARGA
══════════════════════════════ */
async function repFetchLatestExtra(section) {
  try {
    const rows = await sbFetch('dt_reportes_extra', `select=created_at,created_by,by_country,global&section=eq.${section}&order=created_at.desc&limit=1`);
    return (rows && rows.length > 0) ? rows[0] : null;
  } catch (err) {
    // Sin supabase/04_reporte_extra.sql todavía: esa columna simplemente sale vacía
    console.warn(`Reporte: no se pudo leer "${section}" de dt_reportes_extra`, err);
    return null;
  }
}

/* Trae los últimos 2 snapshots guardados (el actual + el anterior, para deltas) */
async function repFetchLatestTwo() {
  try {
    return await sbFetch('dt_reportes_ventas', 'select=created_at,created_by,by_country,global&order=created_at.desc&limit=2');
  } catch (err) {
    console.error('Error cargando últimos snapshots:', err);
    return [];
  }
}

/* Carga lo último de las 4 fuentes y lo muestra para cualquiera que entre.
   silent = refresco (auto-refresh o tras guardar): no toca lo que se está pegando. */
async function repLoadCurrentReport(silent = false) {
  const [latestTwo, check, wait, coverage] = await Promise.all([
    repFetchLatestTwo(),
    repFetchLatestExtra('check'),
    repFetchLatestExtra('wait'),
    leadsFetchLatest(),
  ]);
  repExtra = { check, wait };
  repCoverageRow = coverage;

  const [latest, prev] = latestTwo;
  repLatestApprove = latest || null;
  repPrevSnapshot = prev || null;

  if (latest) {
    repByCountry = (latest.by_country || []).map(c => ({ ...c }));
    repGlobal = { ...latest.global };
    // Deltas de la tabla (▲ +5.9pts): SOLO contra la actualización anterior del MISMO día.
    // La primera carga del día no muestra subida ni bajada. (La gráfica de Evolución sigue comparando con ayer.)
    const sameDayPrev = repPrevSnapshot && repSameDay(latest.created_at, repPrevSnapshot.created_at) ? repPrevSnapshot : null;
    const prevByCountry = sameDayPrev ? (sameDayPrev.by_country || []) : [];
    repByCountry.forEach(c => {
      const p = prevByCountry.find(x => x.country === c.country);
      c.deltaPct = p ? c.approvePct - p.approvePct : null;
      c.prevApprovePct = p ? p.approvePct : null;
    });
    repGlobal.deltaPct = repPrevSnapshot ? repGlobal.approvePct - repPrevSnapshot.global.approvePct : null;
    repGlobal.prevApprovePct = repPrevSnapshot ? repPrevSnapshot.global.approvePct : null;

    const todaySnaps = await repFetchSnapshotsForRange('today');
    repRenderSummary(todaySnaps);
    repRenderKPIs();
  } else {
    repByCountry = [];
    repGlobal = { total: 0, approved: 0, approvePct: 0 };
    document.getElementById('rep-summary').style.display = 'none';
    document.getElementById('rep-kpis').style.display = 'none';
  }

  repRenderCard();
  repRenderSourceLastUpdates();
}

async function repInitView() {
  repLoaded = true;
  const canApprove = can('reportes.save');
  const canCoverage = can('leads.save');
  document.getElementById('rep-paste-panel').style.display = (canApprove || canCoverage) ? 'block' : 'none';
  const note = document.getElementById('rep-tl-note');
  note.style.display = canApprove ? 'none' : 'flex';
  note.querySelector('small').textContent = canCoverage
    ? 'Puedes actualizar la sección 4 (Operational Coverage). Las secciones 1 a 3 las actualizan las cuentas con ese permiso.'
    : 'Tu cuenta no tiene permiso para actualizar este reporte — puedes ver la información aquí en cualquier momento.';

  repRenderSourceForms();
  repSyncModeButtons();
  await Promise.all([repLoadCurrentReport(), repFetchDataLinks()]);
  repRenderDataLinks();
  if (repCoverageRow) leadsApplyCooldown(repCoverageRow.created_at);
  repLoadHistory();
}

/* ══════════════════════════════
   RESUMEN Y KPIs (fuente ①)
══════════════════════════════ */
function repDeltaHTML(delta) {
  if (delta === null || delta === undefined || isNaN(delta)) return '';
  if (Math.abs(delta) < 0.3) return `<span class="rep-delta rep-delta-flat">→ estable</span>`;
  const up = delta > 0;
  return `<span class="rep-delta ${up ? 'rep-delta-up' : 'rep-delta-down'}">${up ? '▲' : '▼'} ${up ? '+' : ''}${delta.toFixed(1)}pts</span>`;
}

function repTimeAgo(iso) {
  const diffMin = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (diffMin < 1) return 'hace un momento';
  if (diffMin < 60) return `hace ${diffMin} minuto${diffMin !== 1 ? 's' : ''}`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `hace ${diffH} hora${diffH !== 1 ? 's' : ''}`;
  const diffD = Math.round(diffH / 24);
  return `hace ${diffD} día${diffD !== 1 ? 's' : ''}`;
}

function repBuildSummary(todaySnapshots) {
  if (!repPrevSnapshot) {
    return 'Este es tu primer snapshot guardado — a partir de ahora vas a poder ver aquí tu evolución.';
  }
  const delta = repGlobal.deltaPct;
  const ago = repTimeAgo(repPrevSnapshot.created_at);
  const prevPct = repPrevSnapshot.global.approvePct;
  let phrase;
  if (Math.abs(delta) < 0.3) {
    phrase = `Vas estable respecto a ${ago} (${repFmtPct(prevPct)} → ${repFmtPct(repGlobal.approvePct)}).`;
  } else if (delta > 0) {
    phrase = `Vas ${delta.toFixed(1)} puntos arriba que ${ago} (${repFmtPct(prevPct)} → ${repFmtPct(repGlobal.approvePct)}). 📈`;
  } else {
    phrase = `Vas ${Math.abs(delta).toFixed(1)} puntos abajo que ${ago} (${repFmtPct(prevPct)} → ${repFmtPct(repGlobal.approvePct)}). 📉`;
  }

  const todayPcts = (todaySnapshots || []).map(h => h.global.approvePct);
  if (todayPcts.length > 0) {
    const maxToday = Math.max(...todayPcts, repGlobal.approvePct);
    const minToday = Math.min(...todayPcts, repGlobal.approvePct);
    if (repGlobal.approvePct >= maxToday && maxToday > minToday) {
      phrase += ' Es el mejor momento del día hasta ahora.';
    } else if (repGlobal.approvePct <= minToday && maxToday > minToday) {
      phrase += ' Es el punto más bajo del día — vale la pena revisar qué está pasando.';
    }
  }
  return phrase;
}

function repRenderSummary(todaySnapshots) {
  const box = document.getElementById('rep-summary');
  const textEl = document.getElementById('rep-summary-text');
  textEl.textContent = repBuildSummary(todaySnapshots);
  box.style.display = 'flex';
}

function repRenderKPIs() {
  const kpiWrap = document.getElementById('rep-kpis');
  const gCls = repApproveClass(repGlobal.approvePct);
  const gColorCls = gCls === 'rep-approve-good' ? 'ol-kpi-green' : gCls === 'rep-approve-bad' ? 'ol-kpi-red' : '';
  const deltaHtml = repDeltaHTML(repGlobal.deltaPct);
  kpiWrap.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">Leads Totales</span></div>
      <div class="kpi-value">${escapeHtml(repGlobal.total.toLocaleString('es-PE'))}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">Aprobados</span></div>
      <div class="kpi-value ol-kpi-green">${escapeHtml(repGlobal.approved.toLocaleString('es-PE'))}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">% Approve Global</span></div>
      <div class="kpi-value ${gColorCls}">${repFmtPct(repGlobal.approvePct)}</div>
      ${deltaHtml ? `<div class="kpi-footer">${deltaHtml}<span class="kpi-sub">vs. snapshot anterior</span></div>` : ''}
      ${repGlobal.prevApprovePct != null ? `<div class="kpi-sub">snapshot anterior: ${repFmtPct(repGlobal.prevApprovePct)}</div>` : ''}
    </div>`;
  kpiWrap.style.display = 'grid';
}

/* ══════════════════════════════
   TABLA TIPO IMAGEN — las 4 fuentes juntas, una fila por país con algún dato
══════════════════════════════ */
const REP_VALUE_MODE_KEY = 'gc_rep_value_mode';
let repValueMode = (() => {
  try { return localStorage.getItem(REP_VALUE_MODE_KEY) === 'count' ? 'count' : 'pct'; } catch { return 'pct'; }
})();

function repSetValueMode(mode) {
  repValueMode = mode === 'count' ? 'count' : 'pct';
  try { localStorage.setItem(REP_VALUE_MODE_KEY, repValueMode); } catch { /* sin storage: no se recuerda */ }
  repSyncModeButtons();
  repRenderCard();
}

function repSyncModeButtons() {
  document.querySelectorAll('.rep-mode-btn').forEach(b => {
    const on = b.dataset.mode === repValueMode;
    b.classList.toggle('btn-primary', on);
    b.classList.toggle('btn-ghost', !on);
  });
}

/* Clave para cruzar países entre fuentes: sin tildes, minúsculas, espacios normalizados */
function repCountryKey(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function repBuildCombinedRows() {
  const map = new Map();
  const slot = (name) => {
    const k = repCountryKey(name);
    if (!k) return null;
    if (!map.has(k)) map.set(k, { country: String(name).trim() });
    return map.get(k);
  };
  repByCountry.forEach(c => { const r = slot(c.country); if (r) r.main = c; });
  ((repExtra.check || {}).by_country || []).forEach(c => { const r = slot(c.country); if (r) r.check = c; });
  ((repExtra.wait || {}).by_country || []).forEach(c => { const r = slot(c.country); if (r) r.wait = c; });
  ((repCoverageRow || {}).by_country || []).forEach(c => { const r = slot(c.country); if (r) r.cov = repCoverageFor(c); });

  // Solo los países con al menos algún dato en alguna de las 4 fuentes
  const hasData = r =>
    (r.main && (r.main.total > 0 || r.main.approved > 0)) ||
    (r.check && (r.check.total > 0 || (r.check.avgPrice || 0) > 0)) ||
    (r.wait && r.wait.waitSec > 0) ||
    (r.cov && (r.cov.totalOrders > 0 || r.cov.available > 0 || r.cov.opsOnline > 0));
  return [...map.values()].filter(hasData).sort((a, b) => a.country.localeCompare(b.country));
}

/* ── Colores tipo semáforo ── */
const REP_RGB_GREEN = '34,197,94';
const REP_RGB_RED   = '239,68,68';
function repBg(rgb, alpha) { return `background:rgba(${rgb},${alpha.toFixed(2)});`; }

/* % "bueno" (≤ good) en verde — más fuerte mientras más cerca de 0; % "malo" (≥ bad) en rojo hasta cap */
function repHeat(pct, [good, bad, cap]) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '';
  if (pct <= good) return repBg(REP_RGB_GREEN, 0.12 + 0.22 * (good > 0 ? 1 - pct / good : 1));
  if (pct >= bad) return repBg(REP_RGB_RED, 0.14 + 0.40 * Math.min(1, (pct - bad) / Math.max(1, cap - bad)));
  return '';
}

/* Approve %: mismo semáforo de toda la app — rojo < 25, neutro 25-30, verde ≥ 30 */
function repHeatApprove(pct) {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return '';
  if (pct >= 30) return repBg(REP_RGB_GREEN, 0.16 + 0.30 * Math.min(1, (pct - 30) / 15));
  if (pct < 25) return repBg(REP_RGB_RED, 0.22 + 0.36 * Math.min(1, (25 - pct) / 20));
  return repBg(REP_RGB_RED, 0.07);
}

/* Wait: 0:00:00 en verde; desde ahí se pone más rojo mientras más acumula (tope: capHours) */
function repHeatWait(sec, capHours = 4) {
  if (sec === null || sec === undefined) return '';
  if (sec <= 0) return repBg(REP_RGB_GREEN, 0.22);
  return repBg(REP_RGB_RED, 0.06 + 0.52 * Math.min(1, sec / (capHours * 3600)));
}

/* Leads disponibles: rojo si no alcanzan ni para 1 OP (< 30), verde creciente con el volumen */
function repHeatAvailable(v) {
  if (v === null || v === undefined) return '';
  if (v < 10) return repBg(REP_RGB_RED, 0.55);
  if (v < REP_LEADS_PER_OP) return repBg(REP_RGB_RED, 0.38);
  if (v < REP_LEADS_PER_OP * 2) return repBg(REP_RGB_RED, 0.14);
  return repBg(REP_RGB_GREEN, 0.10 + 0.35 * Math.min(1, v / 1000));
}

function repHeatOpsDelta(d) {
  if (!d) return '';
  return d > 0 ? repBg(REP_RGB_GREEN, 0.30) : repBg(REP_RGB_RED, 0.36);
}

/* Estados de la sección ①. pctMode = qué se ve en modo "%": New va en cantidad (como la imagen).
   heat = [verde hasta, rojo desde, rojo máximo en] (en % del total de leads) */
const REP_STATUS_COLS = [
  { key: 'new',      label: 'NEW',       pctMode: false, heat: [10, 15, 40] },
  { key: 'recall',   label: 'RECALL',    pctMode: true,  heat: [6, 10, 30] },
  { key: 'noAnswer', label: 'NO ANSWER', pctMode: true,  heat: [20, 30, 60] },
];
const REP_STATUS_COLS_AFTER = [
  { key: 'reject',   label: 'REJECT',    pctMode: true,  heat: [12, 25, 45] },
  { key: 'trash',    label: 'TRASH',     pctMode: true,  heat: null },
];

function repPctOf(n, total) { return total > 0 ? (n / total) * 100 : 0; }
function repFmtPct0(p) { return `${Math.round(p)}%`; }

/* Celda de un estado: en modo % muestra el %, en modo cantidades el número; el otro va en el tooltip */
function repStatusCell(col, count, total, extraCls = '') {
  const pct = repPctOf(count, total);
  const showPct = repValueMode === 'pct' && col.pctMode;
  const text = showPct ? repFmtPct0(pct) : count.toLocaleString('es-PE');
  const title = showPct ? `${count.toLocaleString('es-PE')} de ${total.toLocaleString('es-PE')}` : `${pct.toFixed(1)}% del total`;
  const style = col.heat && total > 0 ? repHeat(pct, col.heat) : '';   // sin leads no hay nada que colorear
  return `<td class="${extraCls}" style="${style}" title="${escapeHtml(title)}">${text}</td>`;
}

const REP_NA = '<span class="rep-na">—</span>';

function repRowHTML(r) {
  const m = r.main;
  let html = `<td class="rep-country">${countryFlag(r.country)}${escapeHtml(r.country)}</td>`;

  // ① Leads & Approve
  if (m) {
    html += `<td>${m.total.toLocaleString('es-PE')}</td>`;
    REP_STATUS_COLS.forEach(col => { html += repStatusCell(col, m[col.key] || 0, m.total); });
    html += `<td class="rep-strong">${(m.approved || 0).toLocaleString('es-PE')}</td>`;
    html += m.total > 0
      ? `<td class="rep-strong" style="${repHeatApprove(m.approvePct)}">${repFmtPct(m.approvePct)}${m.deltaPct != null ? `<span class="rep-grid-delta">${repDeltaHTML(m.deltaPct)}</span>` : ''}</td>`
      : `<td>${REP_NA}</td>`;
    REP_STATUS_COLS_AFTER.forEach(col => { html += repStatusCell(col, m[col.key] || 0, m.total); });
  } else {
    html += `<td>${REP_NA}</td>`.repeat(3 + REP_STATUS_COLS.length + REP_STATUS_COLS_AFTER.length);
  }

  // ② Check
  html += `<td class="rep-sep-2 rep-strong">${r.check ? repFmtMoney(r.check.avgPrice) : REP_NA}</td>`;

  // ③ Wait
  html += r.wait
    ? `<td class="rep-sep-3" style="${repHeatWait(r.wait.waitSec)}">${repFmtDuration(r.wait.waitSec)}</td>`
    : `<td class="rep-sep-3">${REP_NA}</td>`;

  // ④ Coverage
  const c = r.cov;
  if (c) {
    const delta = c.opsDelta;
    html += `<td class="rep-sep-4 rep-strong" style="${repHeatAvailable(c.available)}">${c.available.toLocaleString('es-PE')}</td>`;
    html += `<td>${c.totalOrders.toLocaleString('es-PE')}</td>`;
    html += `<td>${c.opsOnline}</td>`;
    html += `<td class="rep-strong" style="${repHeatOpsDelta(delta)}" title="Ideal: ${Math.round(c.available / REP_LEADS_PER_OP)} OPs (1 cada ${REP_LEADS_PER_OP} leads disponibles)">${delta > 0 ? '+' : ''}${delta}</td>`;
    html += c.currentQueue
      ? `<td>${escapeHtml(c.currentQueue)}</td>`
      : `<td class="rep-queue-none" style="${repBg(REP_RGB_RED, 0.45)}">NO AVAILABLE<br>LEADS</td>`;
  } else {
    html += `<td class="rep-sep-4">${REP_NA}</td>` + `<td>${REP_NA}</td>`.repeat(4);
  }
  return `<tr>${html}</tr>`;
}

function repTotalRowHTML(rows) {
  const mains = rows.map(r => r.main).filter(Boolean);
  const sum = key => mains.reduce((s, m) => s + (m[key] || 0), 0);
  const total = sum('total');
  let html = `<td class="rep-country">GRAND TOTAL</td>`;

  if (mains.length) {
    html += `<td>${total.toLocaleString('es-PE')}</td>`;
    REP_STATUS_COLS.forEach(col => { html += repStatusCell(col, sum(col.key), total); });
    const approved = sum('approved');
    const pct = repPctOf(approved, total);
    html += `<td>${approved.toLocaleString('es-PE')}</td>`;
    html += `<td style="${repHeatApprove(pct)}">${repFmtPct(pct)}</td>`;
    REP_STATUS_COLS_AFTER.forEach(col => { html += repStatusCell(col, sum(col.key), total); });
  } else {
    html += `<td>${REP_NA}</td>`.repeat(3 + REP_STATUS_COLS.length + REP_STATUS_COLS_AFTER.length);
  }

  const checkGlobal = (repExtra.check || {}).global || {};
  html += `<td class="rep-sep-2" title="${checkGlobal.method === 'weighted' ? 'Promedio ponderado por approves (ingreso total ÷ approves)' : 'Promedio simple de los países (todavía sin approves)'}">${repFmtMoney(checkGlobal.avgPrice)}</td>`;

  const waits = rows.map(r => r.wait).filter(Boolean);
  const waitSum = waits.reduce((s, w) => s + w.waitSec, 0);
  html += waits.length
    ? `<td class="rep-sep-3" style="${repHeatWait(waitSum, 8)}">${repFmtDuration(waitSum)}</td>`
    : `<td class="rep-sep-3">${REP_NA}</td>`;

  const covs = rows.map(r => r.cov).filter(Boolean);
  if (covs.length) {
    const cs = key => covs.reduce((s, c) => s + c[key], 0);
    html += `<td class="rep-sep-4">${cs('available').toLocaleString('es-PE')}</td><td>${cs('totalOrders').toLocaleString('es-PE')}</td><td>${cs('opsOnline')}</td><td></td><td></td>`;
  } else {
    html += `<td class="rep-sep-4">${REP_NA}</td>` + '<td></td>'.repeat(4);
  }
  return `<tr class="rep-total">${html}</tr>`;
}

/* Última actualización de cada fuente: { at, by } o null */
function repSourceMeta() {
  const meta = row => row ? { at: row.created_at, by: row.created_by } : null;
  return { approve: meta(repLatestApprove), check: meta(repExtra.check), wait: meta(repExtra.wait), coverage: meta(repCoverageRow) };
}

function repFmtDateTime(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}

function repSameDay(isoA, isoB) {
  const a = new Date(isoA), b = new Date(isoB);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function repIsToday(iso) { return repSameDay(iso, new Date().toISOString()); }

/* Última actualización de cada fuente — en su pestaña (hora corta) y junto a su link (detalle).
   Ya no va dentro de la tabla, así no sale en la imagen exportada. */
function repRenderSourceLastUpdates() {
  const meta = repSourceMeta();
  REP_SOURCES.forEach(s => {
    const m = meta[s.key];
    const old = m && !repIsToday(m.at);
    const tab = document.getElementById(`rep-src-tabtime-${s.key}`);
    if (tab) {
      tab.textContent = m ? (old ? repFmtDateTime(m.at) : new Date(m.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })) : 'sin datos';
      tab.classList.toggle('rep-src-old', !!old);
      tab.title = m ? `Última actualización: ${repFmtDateTime(m.at)}${m.by ? ` · ${m.by}` : ''}` : 'Todavía no hay datos guardados de esta fuente';
    }
    const info = document.getElementById(`rep-src-lastinfo-${s.key}`);
    if (info) {
      info.textContent = m
        ? `Última actualización: ${repFmtDateTime(m.at)} (${repTimeAgo(m.at)})${m.by ? ` · ${m.by}` : ''}${old ? ' — de otro día' : ''}`
        : 'Todavía no hay datos guardados de esta fuente.';
      info.classList.toggle('rep-src-old', !!old);
    }
  });
}

function repRenderCard() {
  const panel = document.getElementById('rep-report-panel');
  const card = document.getElementById('rep-report-card');
  const empty = document.getElementById('rep-empty-state');
  const rows = repBuildCombinedRows();

  if (rows.length === 0) {
    panel.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  panel.style.display = 'block';

  // Fecha y hora del reporte = la actualización más reciente de cualquiera de las 4 fuentes
  const meta = repSourceMeta();
  const times = Object.values(meta).filter(Boolean).map(m => new Date(m.at).getTime());
  const stamp = new Date(Math.max(...times));
  card.dataset.stamp = stamp.toISOString();

  const statusHead = cols => cols.map(c => `<th>${c.label}</th>`).join('');

  card.innerHTML = `
    <div class="rep-card-head">
      <div class="rep-card-stamp">
        <span>${stamp.toLocaleDateString('es-PE', { day: 'numeric', month: 'numeric', year: 'numeric' })}</span>
        <span>${stamp.toLocaleTimeString('es-PE', { hour: 'numeric', minute: '2-digit', hour12: true })}</span>
      </div>
      <div class="rep-card-title">New Report</div>
    </div>
    <table class="rep-grid">
      <thead>
        <tr class="rep-grid-groups">
          <th colspan="${3 + REP_STATUS_COLS.length + REP_STATUS_COLS_AFTER.length + 1}" class="rep-g rep-g1"><span class="rep-src-num rep-src-num-1">1</span> Leads &amp; Approve</th>
          <th class="rep-g rep-g2 rep-sep-2"><span class="rep-src-num rep-src-num-2">2</span> Check</th>
          <th class="rep-g rep-g3 rep-sep-3"><span class="rep-src-num rep-src-num-3">3</span> Wait</th>
          <th colspan="5" class="rep-g rep-g4 rep-sep-4"><span class="rep-src-num rep-src-num-4">4</span> Operational Coverage</th>
        </tr>
        <tr>
          <th>COUNTRY</th><th>LEADS</th>${statusHead(REP_STATUS_COLS)}<th>APPROVE</th><th>%</th>${statusHead(REP_STATUS_COLS_AFTER)}
          <th class="rep-sep-2">AVG PRICE</th>
          <th class="rep-sep-3 rep-th-wait">T.WAIT<br>(CC-PERU)</th>
          <th class="rep-sep-4">ORDERS<br>AVAILABLE</th><th>TOTAL<br>ORDERS</th><th>TOTAL OPS<br>(ONLINE)</th><th>OPS +/-</th><th>CURRENT<br>QUEUES</th>
        </tr>
      </thead>
      <tbody>${rows.map(repRowHTML).join('')}</tbody>
      <tfoot>${repTotalRowHTML(rows)}</tfoot>
    </table>`;
}

/* ══════════════════════════════
   EXPORTAR COMO IMAGEN (descargar / copiar para WhatsApp)
══════════════════════════════ */
const REP_H2C_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
let repH2cPromise = null;

/* html2canvas se carga solo la primera vez que alguien exporta (no pesa en la carga de la página) */
function repLoadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (!repH2cPromise) {
    repH2cPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = REP_H2C_URL;
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => { repH2cPromise = null; s.remove(); reject(new Error('No se pudo cargar la herramienta de captura. Revisa tu conexión e intenta de nuevo.')); };
      document.head.appendChild(s);
    });
  }
  return repH2cPromise;
}

/* Exportar una tarjeta armada aparte (Top Team Leader, Leads por Campaña): se pone fuera de pantalla,
   se captura y se copia o descarga como PNG, mostrando el avance en statusId y bloqueando los botones.
   build() devuelve el nodo a capturar (con ancho fijo en su CSS: así sale igual desde cualquier pantalla). */
async function exportCardImage({ action, build, filename, statusId, buttonIds }) {
  const status = document.getElementById(statusId);
  const btns = buttonIds.map(id => document.getElementById(id)).filter(Boolean);
  btns.forEach(b => { b.disabled = true; });
  status.style.color = 'var(--text-light)';
  status.textContent = 'Generando imagen…';
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-30000px;top:0;';
  try {
    const h2c = await repLoadHtml2Canvas();
    const card = build();
    holder.appendChild(card);
    document.body.appendChild(holder);
    await Promise.all([...card.querySelectorAll('img')].map(img =>
      img.complete ? null : new Promise(resolve => { img.onload = img.onerror = resolve; })));
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--card-bg').trim() || '#1c1e21';
    const canvas = await h2c(card, { backgroundColor: bg, scale: 2, useCORS: true, logging: false, windowWidth: 1400, windowHeight: 1200 });
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('No se pudo generar la imagen.');
    if (action === 'copy') {
      if (!(navigator.clipboard && window.ClipboardItem && window.isSecureContext)) {
        throw new Error('Este navegador no permite copiar imágenes — usa "Descargar imagen".');
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      status.textContent = '✓ Imagen copiada — pégala en WhatsApp';
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      status.textContent = '✓ Imagen descargada';
    }
    status.style.color = 'var(--green)';
    setTimeout(() => { status.textContent = ''; }, 5000);
  } catch (err) {
    console.error('Error exportando imagen:', err);
    status.style.color = 'var(--red)';
    status.textContent = (err && err.message) ? err.message : 'No se pudo generar la imagen.';
  } finally {
    holder.remove();
    btns.forEach(b => { b.disabled = false; });
  }
}

/* La imagen sale SIEMPRE igual, sin importar el zoom, el tamaño de la ventana o la pantalla de quien
   la genera: se captura una COPIA de la tabla, fuera de la vista, con ancho y letra fijos
   (.rep-export en views.css), escala fija y banderas en alta resolución.
   Resultado: ~3600 px de ancho — nítida en WhatsApp aunque la comprima. */
const REP_EXPORT_SCALE = 2;
const REP_EXPORT_WINDOW = 2000;   // ancho "de escritorio" para la copia: nunca aplica el diseño de celular

async function repCaptureCard() {
  const h2c = await repLoadHtml2Canvas();
  const clone = document.getElementById('rep-report-card').cloneNode(true);
  clone.removeAttribute('id');
  clone.classList.add('rep-export');
  clone.querySelectorAll('img[src*="flagcdn.com"]').forEach(img => {
    img.removeAttribute('srcset');
    img.src = img.src.replace(/\/\d+x\d+\//, '/80x60/');   // bandera grande → nítida al escalar
    img.width = 30;
    img.height = 22;
  });

  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-30000px;top:0;';
  holder.appendChild(clone);
  document.body.appendChild(holder);
  try {
    await Promise.all([...clone.querySelectorAll('img')].map(img =>
      img.complete ? null : new Promise(resolve => { img.onload = img.onerror = resolve; })));
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--card-bg').trim() || '#1c1e21';
    return await h2c(clone, {
      backgroundColor: bg, scale: REP_EXPORT_SCALE, useCORS: true, logging: false,
      windowWidth: REP_EXPORT_WINDOW, windowHeight: 1200,
    });
  } finally {
    holder.remove();
  }
}

async function repExportImage(action) {
  const status = document.getElementById('rep-export-status');
  const btns = [document.getElementById('rep-copy-img-btn'), document.getElementById('rep-dl-img-btn')];
  btns.forEach(b => { if (b) b.disabled = true; });
  status.style.color = 'var(--text-light)';
  status.textContent = 'Generando imagen…';
  try {
    const canvas = await repCaptureCard();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('No se pudo generar la imagen.');

    if (action === 'copy') {
      if (!(navigator.clipboard && window.ClipboardItem && window.isSecureContext)) {
        throw new Error('Este navegador no permite copiar imágenes — usa "Descargar imagen".');
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      status.style.color = 'var(--green)';
      status.textContent = '✓ Imagen copiada — pégala en WhatsApp con Ctrl+V';
    } else {
      const d = new Date(document.getElementById('rep-report-card').dataset.stamp || Date.now());
      const pad = n => String(n).padStart(2, '0');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `reporte-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      status.style.color = 'var(--green)';
      status.textContent = '✓ Imagen descargada';
    }
    setTimeout(() => { status.textContent = ''; }, 5000);
  } catch (err) {
    console.error('Error exportando el reporte como imagen:', err);
    status.style.color = 'var(--red)';
    status.textContent = (err && err.message) ? err.message : 'No se pudo generar la imagen.';
  } finally {
    btns.forEach(b => { if (b) b.disabled = false; });
  }
}


/* ══════════════════════════════
   EVOLUCIÓN DEL % APPROVE (fuente ①)
   · Rangos: Hoy · Ayer · Últimos 7 días · Mes actual · Mes anterior.
     En Hoy/Ayer se ven todos los reportes del día; en 7 días y meses, el último reporte de cada día.
   · Varias series a la vez (Total y/o países) en líneas, con la cantidad de leads como barras de fondo.
   · Resumen del periodo por serie (inicio → final, promedio, mínimo y máximo).
   · Mapa de calor país × hora: el Approve acumulado del día a cada hora (último reporte de cada hora).
══════════════════════════════ */
let repDateFilter = 'today'; // 'today' | 'yesterday' | '7d' | 'month' | 'prevmonth'
const REP_DATE_FILTERS = ['today', 'yesterday', '7d', 'month', 'prevmonth'];
const REP_PER_DAY_FILTERS = ['7d', 'month', 'prevmonth'];
const REP_TOTAL_COLOR = '#e8eaed';
const REP_SERIES_KEY = 'gc_rep_series';

/* Series elegidas en la gráfica ('Total' y/o nombres de país). Se recuerdan por navegador. */
let repChartSel = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(REP_SERIES_KEY) || 'null');
    return new Set(Array.isArray(v) && v.length ? v : ['Total']);
  } catch { return new Set(['Total']); }
})();
function repSaveSeries() { try { localStorage.setItem(REP_SERIES_KEY, JSON.stringify([...repChartSel])); } catch { /* sin storage */ } }

function repLocalDayStart(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}
function repMonthStart(offset) { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + offset, 1); }
function repMonthName(offset) {
  const s = repMonthStart(offset).toLocaleDateString('es-PE', { month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function repDateBoundsFor(filter) {
  if (filter === 'today') return { start: repLocalDayStart(0), end: repLocalDayStart(1) };
  if (filter === 'yesterday') return { start: repLocalDayStart(-1), end: repLocalDayStart(0) };
  if (filter === 'month') return { start: repMonthStart(0), end: repMonthStart(1) };
  if (filter === 'prevmonth') return { start: repMonthStart(-1), end: repMonthStart(0) };
  const end = new Date(); const start = new Date(); start.setDate(start.getDate() - 7);   // '7d'
  return { start, end };
}

function repSyncMonthButtons() {
  const cur = document.querySelector('.rep-date-btn[data-filter="month"]');
  const prev = document.querySelector('.rep-date-btn[data-filter="prevmonth"]');
  if (cur) cur.textContent = `${repMonthName(0)} (en curso)`;
  if (prev) prev.textContent = repMonthName(-1);
}

function repSetDateFilter(value) {
  if (!REP_DATE_FILTERS.includes(value)) return;
  repDateFilter = value;
  document.querySelectorAll('.rep-date-btn').forEach(b => {
    const active = b.dataset.filter === value;
    b.classList.toggle('btn-primary', active);
    b.classList.toggle('btn-ghost', !active);
  });
  repLoadHistory();
}

/* Trae snapshots (created_at,by_country,global) para un rango de fecha dado (lo usa también el Inicio) */
async function repFetchSnapshotsForRange(filter) {
  try {
    const bounds = repDateBoundsFor(filter);
    let query = 'select=created_at,by_country,global&order=created_at.asc';
    query += `&created_at=gte.${encodeURIComponent(bounds.start.toISOString())}`;
    query += `&created_at=lt.${encodeURIComponent(bounds.end.toISOString())}`;
    return await sbFetchAll('dt_reportes_ventas', query, 500);
  } catch (err) {
    console.error('Error cargando snapshots:', err);
    return [];
  }
}

/* Trae el snapshot guardado más reciente (lo usa Leads por Campaña para su badge de Approve) */
async function repFetchPrevSnapshot() {
  try {
    const rows = await sbFetch('dt_reportes_ventas', 'select=created_at,by_country,global&order=created_at.desc&limit=1');
    return (rows && rows.length > 0) ? rows[0] : null;
  } catch (err) {
    console.error('Error cargando snapshot anterior:', err);
    return null;
  }
}

let repYesterdayHistory = [];

async function repLoadHistory() {
  repSyncMonthButtons();
  const [hist, yHist] = await Promise.all([
    repFetchSnapshotsForRange(repDateFilter),
    repDateFilter === 'today' ? repFetchSnapshotsForRange('yesterday') : Promise.resolve([]),
  ]);
  repHistory = hist;
  repYesterdayHistory = yHist;
  repRenderChart();
}

function repPerDay() { return REP_PER_DAY_FILTERS.includes(repDateFilter); }
function repChartPoints() { return repPerDay() ? dashLastSnapshotPerDay(repHistory) : repHistory; }

/* Busca en `snapshots` el más cercano a la misma hora del día que `targetDate` (tolerancia 90 min) */
function repNearestByTimeOfDay(targetDate, snapshots) {
  const targetMinutes = targetDate.getHours() * 60 + targetDate.getMinutes();
  let best = null, bestDiff = Infinity;
  snapshots.forEach(s => {
    const d = new Date(s.created_at);
    const diff = Math.abs((d.getHours() * 60 + d.getMinutes()) - targetMinutes);
    if (diff < bestDiff) { bestDiff = diff; best = s; }
  });
  return (best && bestDiff <= 90) ? best : null;
}

function repFmtTimestamp(iso) {
  const d = new Date(iso);
  if (repPerDay()) return d.toLocaleDateString('es-PE', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '');
  return d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
}

function repColorFor(country, i) {
  return REP_COUNTRY_COLORS[country] || REP_FALLBACK_COLORS[i % REP_FALLBACK_COLORS.length];
}
function repSeriesColor(series, allCountries) {
  return series === 'Total' ? REP_TOTAL_COLOR : repColorFor(series, Math.max(0, allCountries.indexOf(series)));
}

/* Color de cada barra según el semáforo: rojo <25%, neutro 25-30%, verde 30%+ (lo usa el Inicio) */
function repBarColor(pct) {
  if (pct === null || pct === undefined) return 'transparent';
  if (pct < 25) return '#f87171';
  if (pct < 30) return 'rgba(100,116,139,.35)';
  return '#4ade80';
}

/* { pct, leads } de la serie elegida ('Total' = global, o un país) dentro de un snapshot */
function repSeriesPoint(snapshot, series) {
  if (!snapshot) return { pct: null, leads: null };
  if (series === 'Total') {
    const g = snapshot.global || {};
    return { pct: g.approvePct ?? null, leads: g.total ?? null };
  }
  const c = (snapshot.by_country || []).find(x => x.country === series);
  return c ? { pct: c.approvePct, leads: c.total } : { pct: null, leads: null };
}
function repValueForSeries(snapshot, series) { return repSeriesPoint(snapshot, series).pct; }

function repToggleSeries(series) {
  if (repChartSel.has(series)) {
    if (repChartSel.size === 1) return;   // siempre queda al menos una
    repChartSel.delete(series);
  } else {
    repChartSel.add(series);
  }
  repSaveSeries();
  repRenderChart();
}
/* (nombre anterior, por compatibilidad) */
function repSelectSeries(series) { repToggleSeries(series); }

function repRenderChart() {
  const countEl = document.getElementById('rep-snap-count');
  const points = repChartPoints();
  countEl.textContent = repPerDay()
    ? `${points.length} día${points.length !== 1 ? 's' : ''} · ${repHistory.length} reporte${repHistory.length !== 1 ? 's' : ''} (se muestra el último de cada día)`
    : `${repHistory.length} reporte${repHistory.length !== 1 ? 's' : ''} en este rango`;

  const emptyEl = document.getElementById('rep-chart-empty');
  const wrapEl  = document.getElementById('rep-chart-wrap');
  const togglesEl = document.getElementById('rep-chart-toggles');

  if (repHistory.length === 0) {
    const filterLabel = { today: 'hoy', yesterday: 'ayer', '7d': 'los últimos 7 días', month: repMonthName(0).toLowerCase(), prevmonth: repMonthName(-1).toLowerCase() }[repDateFilter];
    const p = emptyEl.querySelector('p');
    const small = emptyEl.querySelector('small');
    if (p) p.textContent = `No hay reportes guardados para ${filterLabel}`;
    if (small) small.textContent = 'Prueba con otro rango, o pega los datos de la fuente 1 y guárdalos ahora';
    emptyEl.style.display = 'flex';
    wrapEl.style.display  = 'none';
    togglesEl.innerHTML   = '';
    document.getElementById('rep-period-summary').hidden = true;
    document.getElementById('rep-heat-wrap').hidden = true;
    if (repChartInstance) { repChartInstance.destroy(); repChartInstance = null; }
    return;
  }
  emptyEl.style.display = 'none';
  wrapEl.style.display  = 'block';

  // Países del rango, ordenados por volumen (los que más leads tienen primero)
  const vol = new Map();
  repHistory.forEach(h => (h.by_country || []).forEach(c => vol.set(c.country, Math.max(vol.get(c.country) || 0, c.total || 0))));
  const allCountries = [...vol.keys()].sort((a, b) => (vol.get(b) - vol.get(a)) || a.localeCompare(b));
  [...repChartSel].forEach(s => { if (s !== 'Total' && !allCountries.includes(s)) repChartSel.delete(s); });
  if (!repChartSel.size) repChartSel.add('Total');
  const selected = ['Total', ...allCountries].filter(s => repChartSel.has(s));

  // Chips de selección múltiple
  togglesEl.innerHTML = ['Total', ...allCountries].map(s => {
    const on = repChartSel.has(s);
    const color = s === 'Total' ? 'var(--nav-accent)' : repSeriesColor(s, allCountries);
    return `<button type="button" class="rep-toggle-chip color-chip ${on ? '' : 'off'}" style="--c:${color}" aria-pressed="${on}" onclick="repToggleSeries(${jsArg(s)})">${s === 'Total' ? '' : countryFlag(s)}${escapeHtml(s)}</button>`;
  }).join('');

  const labels = points.map(h => repFmtTimestamp(h.created_at));
  const manyPoints = points.length > 24;

  // Líneas: una por serie elegida (con sus leads guardados para el tooltip)
  const datasets = selected.map(s => {
    const vals = points.map(h => repSeriesPoint(h, s));
    const data = vals.map(v => (v.pct !== null && v.pct !== undefined ? Number(Number(v.pct).toFixed(1)) : null));
    let lastIdx = -1;
    data.forEach((v, i) => { if (v !== null) lastIdx = i; });
    const color = repSeriesColor(s, allCountries);
    return {
      type: 'line', label: s, data, leads: vals.map(v => v.leads),
      borderColor: color, backgroundColor: color, borderWidth: s === 'Total' ? 3 : 2,
      pointRadius: manyPoints ? 0 : 3, pointHoverRadius: 5, tension: 0.3, spanGaps: true,
      yAxisID: 'y', order: 1, _isSeries: true, _lastIdx: lastIdx,
    };
  });

  // Ayer a la misma hora (solo en "Hoy" y con una sola serie: con varias, la gráfica se llenaría de líneas)
  let ghost = [];
  if (repDateFilter === 'today' && selected.length === 1 && repYesterdayHistory.length) {
    const s = selected[0];
    ghost = points.map(h => {
      const v = repValueForSeries(repNearestByTimeOfDay(new Date(h.created_at), repYesterdayHistory), s);
      return v !== null && v !== undefined ? Number(Number(v).toFixed(1)) : null;
    });
    datasets.push({
      type: 'line', label: `${s} · ayer a la misma hora`, data: ghost,
      borderColor: 'rgba(147,168,157,.6)', backgroundColor: 'rgba(147,168,157,.6)', borderDash: [5, 4], borderWidth: 2,
      pointRadius: 0, tension: 0.3, spanGaps: true, yAxisID: 'y', order: 2,
    });
  }

  // Volumen: leads de lo elegido (si está "Total", el total general; si no, la suma de los países)
  const volume = points.map(h => (repChartSel.has('Total')
    ? (h.global || {}).total || 0
    : selected.reduce((sum, s) => sum + (repSeriesPoint(h, s).leads || 0), 0)));
  datasets.push({
    type: 'bar', label: 'Leads (volumen)', data: volume, yAxisID: 'y2', order: 3,
    backgroundColor: 'rgba(156,168,181,.16)', borderRadius: 3, borderSkipped: false, _isVolume: true,
  });

  // Umbrales del semáforo
  datasets.push({ type: 'line', label: 'Umbral 30%', data: labels.map(() => 30), borderColor: 'rgba(34,197,94,.45)', borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0, yAxisID: 'y', order: 4, _isRef: true });
  datasets.push({ type: 'line', label: 'Umbral 25%', data: labels.map(() => 25), borderColor: 'rgba(239,68,68,.45)', borderDash: [4, 4], borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0, yAxisID: 'y', order: 4, _isRef: true });

  // Techo del eje: REP_CHART_MAX_DEFAULT de base, pero nunca corta una línea real
  const seen = datasets.filter(d => d._isSeries).flatMap(d => d.data).concat(ghost).filter(v => v !== null && v !== undefined);
  const axisMax = Math.min(100, Math.max(REP_CHART_MAX_DEFAULT, Math.ceil(((seen.length ? Math.max(...seen) : 0) + 5) / 5) * 5));
  const maxVol = Math.max(1, ...volume);

  if (repChartInstance) repChartInstance.destroy();
  repChartInstance = new Chart(document.getElementById('repChart'), {
    type: 'bar',   // gráfica mixta: cada serie dice si es línea o barra
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { right: 30, top: 6 } },
      plugins: {
        legend: { display: true, labels: { ...chartDefaults.font, boxWidth: 12, filter: item => !datasets[item.datasetIndex]._isRef } },
        tooltip: {
          filter: item => !item.dataset._isRef,
          callbacks: {
            label: ctx => {
              const ds = ctx.dataset;
              if (ds._isVolume) return ` Leads: ${Number(ctx.raw || 0).toLocaleString('es-PE')}`;
              if (ctx.raw === null || ctx.raw === undefined) return null;
              const leads = ds.leads ? ds.leads[ctx.dataIndex] : null;
              return ` ${ds.label}: ${ctx.raw}%${leads !== null && leads !== undefined ? ` · ${Number(leads).toLocaleString('es-PE')} leads` : ''}`;
            },
          },
        },
        datalabels: {
          // Solo el último valor de cada línea, para no tapar la gráfica
          display: ctx => !!ctx.dataset._isSeries && ctx.dataIndex === ctx.dataset._lastIdx,
          formatter: v => `${v}%`,
          color: ctx => ctx.dataset.borderColor,
          textStrokeColor: 'rgba(0,0,0,.7)', textStrokeWidth: 3,
          font: { family: "'Lexend', sans-serif", weight: '700', size: 12 },
          anchor: 'end', align: 'right', offset: 4, clamp: true,
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { ...chartDefaults.font, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: { grid: { color: CHART_GRID }, ticks: { ...chartDefaults.font, callback: v => v + '%' }, min: 0, max: axisMax },
        // Las barras de volumen quedan en el tercio de abajo, sin tapar las líneas
        y2: { position: 'right', grid: { display: false }, beginAtZero: true, suggestedMax: maxVol * 3,
              ticks: { ...chartDefaults.font, font: { size: 10 }, maxTicksLimit: 4, callback: v => Number(v).toLocaleString('es-PE') } },
      },
    },
  });

  repRenderPeriodSummary(points, selected, allCountries);
  repRenderHeatmap(allCountries);
}

/* ── Resumen del periodo: por cada serie elegida, inicio → final, promedio, mínimo y máximo ── */
function repRenderPeriodSummary(points, selected, allCountries) {
  const box = document.getElementById('rep-period-summary');
  const perDay = repPerDay();
  const rows = selected.map(s => {
    const vals = points.map(h => ({ pct: repSeriesPoint(h, s).pct, at: h.created_at })).filter(v => v.pct !== null && v.pct !== undefined);
    if (!vals.length) return '';
    const first = vals[0], last = vals[vals.length - 1];
    const min = vals.reduce((a, b) => (b.pct < a.pct ? b : a));
    const max = vals.reduce((a, b) => (b.pct > a.pct ? b : a));
    const avg = vals.reduce((sum, v) => sum + v.pct, 0) / vals.length;
    const color = repSeriesColor(s, allCountries);
    const when = v => escapeHtml(repFmtTimestamp(v.at));
    const pct = v => `<span class="rep-approve-badge ${repApproveClass(v)}">${repFmtPct(v)}</span>`;
    return `<tr>
      <td class="nowrap"><span class="rep-period-dot" style="background:${color}"></span>${s === 'Total' ? '' : countryFlag(s)}${escapeHtml(s)}</td>
      <td class="nowrap">${pct(first.pct)} → ${pct(last.pct)} ${vals.length > 1 ? repDeltaHTML(last.pct - first.pct) : ''}</td>
      <td class="num">${pct(avg)}</td>
      <td class="nowrap">${pct(min.pct)} <span class="muted-11">${when(min)}</span></td>
      <td class="nowrap">${pct(max.pct)} <span class="muted-11">${when(max)}</span></td>
    </tr>`;
  }).join('');
  box.hidden = !rows;
  box.innerHTML = rows ? `<div class="tbl-wrap"><table class="rep-period-table">
    <thead><tr><th>Serie</th><th>${perDay ? 'Primer día → último día' : 'Primer reporte → último'}</th><th class="num">Promedio ${perDay ? 'del periodo' : 'del día'}</th><th>Mínimo</th><th>Máximo</th></tr></thead>
    <tbody>${rows}</tbody></table></div>` : '';
}

/* ── Mapa de calor país × hora ──
   Cada celda = Approve ACUMULADO del día a esa hora (el último reporte guardado dentro de esa hora).
   En rangos de varios días, el promedio de esa hora entre los días que tienen reporte. */
function repRenderHeatmap(allCountries) {
  const wrap = document.getElementById('rep-heat-wrap');
  const table = document.getElementById('rep-heat');
  // Último snapshot de cada (día, hora)
  const lastByDayHour = new Map();
  repHistory.forEach(h => {
    const d = new Date(h.created_at);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
    const prev = lastByDayHour.get(key);
    if (!prev || new Date(h.created_at) > new Date(prev.created_at)) lastByDayHour.set(key, h);
  });
  const byHour = new Map();   // hora → [snapshots, uno por día]
  lastByDayHour.forEach(h => {
    const hr = new Date(h.created_at).getHours();
    if (!byHour.has(hr)) byHour.set(hr, []);
    byHour.get(hr).push(h);
  });
  const hours = [...byHour.keys()].sort((a, b) => a - b);
  if (!hours.length) { wrap.hidden = true; return; }

  const days = new Set([...lastByDayHour.keys()].map(k => k.split('-').slice(0, 3).join('-'))).size;
  document.getElementById('rep-heat-note').textContent = days > 1
    ? `Promedio de ${days} días · Approve acumulado del día a cada hora (último reporte de esa hora)`
    : 'Approve acumulado del día a cada hora (último reporte de esa hora) · pasa el mouse para ver los leads';

  const cell = (series, hr) => {
    const vals = byHour.get(hr).map(h => repSeriesPoint(h, series)).filter(v => v.pct !== null && v.pct !== undefined && (v.leads || 0) > 0);
    if (!vals.length) return '<td class="rep-heat-na">·</td>';
    const pct = vals.reduce((s, v) => s + Number(v.pct), 0) / vals.length;
    const leads = Math.round(vals.reduce((s, v) => s + Number(v.leads || 0), 0) / vals.length);
    const tip = `${series} · ${String(hr).padStart(2, '0')}:00 — ${pct.toFixed(1)}% · ${leads.toLocaleString('es-PE')} leads${vals.length > 1 ? ` (promedio de ${vals.length} días)` : ''}`;
    return `<td style="${repHeatApprove(pct)}" title="${escapeHtml(tip)}">${pct.toFixed(1)}</td>`;
  };
  const rowsFor = ['Total', ...allCountries];
  table.innerHTML = `
    <thead><tr><th>Campaña</th>${hours.map(h => `<th>${String(h).padStart(2, '0')}h</th>`).join('')}</tr></thead>
    <tbody>${rowsFor.map(s => `<tr class="${s === 'Total' ? 'rep-heat-total' : ''}">
      <td class="nowrap">${s === 'Total' ? 'Total' : `${countryFlag(s)}${escapeHtml(s)}`}</td>${hours.map(h => cell(s, h)).join('')}
    </tr>`).join('')}</tbody>`;
  wrap.hidden = false;
}
