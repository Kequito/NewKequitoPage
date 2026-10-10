/* Vista EQUIPOS 360 (antes "GoodDay") — la ficha completa de cada OP y de cada equipo:
   distribución (dt_dis) + asistencia en vivo (core/attendance.js) + campañas y approve de Approve Stats
   (dt_ops, BI-04 últimos 90 días) + errores de calidad en vivo (core/errors.js: Gestión / Tipificación / Verificación).

   Vistas: Por Team Leader (tarjetas) · Todos los OPs (tabla con filtros) · Ranking de calidad ·
   Bono (descuento por errores de Verificación) · Por día (tabla de calor por día o por mes).
   Bono y Por día se filtran por TURNO (sale del horario de cada OP; ver eqShiftBarHTML).
   Clic en un TL o en un OP → panel lateral con todo el detalle, alertas y "ficha de feedback"
   (copiar resumen / descargar como imagen).

   Se mantienen los nombres de siempre (page 'goodday', permiso view.goodday, loadGoodDay, gdLoaded)
   y los badges compartidos (gdScheduleBadge, gdCountryBadge…) que usan otras secciones. */

/* ══════════════════════════════
   DISTRIBUCIÓN — dt_dis (Supabase)
══════════════════════════════ */
// Columnas en dt_dis — nombres exactos como están en Supabase
const GD_COLS = ['TEAMLEADER','ASESORES','PEROP1AM','PAIS','DESCANSO','HORARIO','EMPRESA','ASISTENCIA'];

let gdLoaded = false;

/* ── Carga de Excel/CSV/TSV para dt_dis (reemplazo total), usada desde "Actualización de Data" ──
   Encabezado actual: TEAMLEADER ASESORES PEROP1AM PAIS DESCANSO HORARIO IGNORAR IGNORAR IGNORAR EMPRESA ASISTENCIA
   La lectura es por NOMBRE de encabezado, no por posición — solo se toman las columnas listadas
   en GD_COLS; cualquier columna llamada "IGNORAR" (haya una o varias) nunca calza con ningún
   nombre de GD_COLS, así que se descarta sola sin necesidad de lógica especial.
   GD_HEADER_ALIASES cubre nombres alternativos que ha tenido la misma columna en versiones
   anteriores del archivo (p.ej. "CAMPAÑA" para lo que en dt_dis sigue siendo la columna PAIS). */
const GD_HEADER_ALIASES = {
  'PAIS': ['PAIS', 'PAÍS', 'CAMPAÑA', 'CAMPANA'],
};

function gdParseWorkbook(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (raw.length === 0) return [];

  const headers = Object.keys(raw[0]);
  const keyMap = {};
  headers.forEach(h => { keyMap[recNormalizeHeader(h)] = h; });

  return raw.map(row => {
    const record = {};
    GD_COLS.forEach(col => {
      const candidates = GD_HEADER_ALIASES[col] || [col];
      const actualKey = candidates.map(c => keyMap[c.toLowerCase()]).find(k => k !== undefined);
      record[col] = actualKey !== undefined ? String(row[actualKey] ?? '').trim() : '';
    });
    return record;
  // El archivo suele traer, después de las filas reales, bloques de relleno (filas vacías)
  // y una tabla-resumen tipo "CONECTADOS Y CAMPAÑAS" con solo PEROP1AM y todo lo demás en blanco.
  // Exigir también TEAMLEADER descarta ambos casos y deja solo las filas de asignación reales.
  }).filter(r => r.PEROP1AM && r.TEAMLEADER);
}

async function gdDeleteAllCurrent() {
  const res = await fetch(`${SB_URL}/rest/v1/dt_dis?PEROP1AM=not.is.null`, {
    method: 'DELETE',
    headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error(`Supabase delete error ${res.status}`);
}

async function gdFetchLastUpload() {
  try {
    const rows = await sbFetch('dt_dis', 'select=uploaded_at&order=uploaded_at.desc&limit=1');
    return (rows && rows.length > 0) ? rows[0].uploaded_at : null;
  } catch (err) {
    console.error('Error obteniendo fecha de carga de dt_dis:', err);
    return null;
  }
}

/* ══════════════════════════════
   BADGES VISUALES — compartidos con Inicio, Recalls, Approve Stats, Stats OPs Today/Live
══════════════════════════════ */
const COUNTRY_FLAGS = {
  'ECUADOR':'🇪🇨','PERU':'🇵🇪','PERÚ':'🇵🇪','COLOMBIA':'🇨🇴','CHILE':'🇨🇱','ARGENTINA':'🇦🇷','MEXICO':'🇲🇽','MÉXICO':'🇲🇽',
  'BOLIVIA':'🇧🇴','VENEZUELA':'🇻🇪','URUGUAY':'🇺🇾','PARAGUAY':'🇵🇾','COSTA RICA':'🇨🇷','PANAMA':'🇵🇦','PANAMÁ':'🇵🇦',
  'GUATEMALA':'🇬🇹','HONDURAS':'🇭🇳','EL SALVADOR':'🇸🇻','NICARAGUA':'🇳🇮','ESPAÑA':'🇪🇸','ESPANA':'🇪🇸','SIN PROGRAMAR':'⚠️',
};

const DAY_COLORS = {
  'LUNES':     { bg:'rgba(37,99,235,.12)',  color:'#2563eb' },
  'MARTES':    { bg:'rgba(192,38,211,.12)', color:'#c026d3' },
  'MIÉRCOLES': { bg:'rgba(180,83,9,.12)',   color:'#b45309' },
  'MIERCOLES': { bg:'rgba(180,83,9,.12)',   color:'#b45309' },
  'JUEVES':    { bg:'rgba(5,150,105,.12)',  color:'#059669' },
  'VIERNES':   { bg:'rgba(194,65,12,.12)',  color:'#c2410c' },
  'SÁBADO':    { bg:'rgba(124,58,237,.12)', color:'#7c3aed' },
  'SABADO':    { bg:'rgba(124,58,237,.12)', color:'#7c3aed' },
  'DOMINGO':   { bg:'rgba(220,38,38,.12)',  color:'#dc2626' },
};

const SCHEDULE_COLORS = {
  '06:00-15:00': { bg:'rgba(161,98,7,.10)',  color:'#a16207' },
  '07:00-16:00': { bg:'rgba(180,83,9,.10)',  color:'#b45309' },
  '08:00-17:00': { bg:'rgba(2,132,199,.10)', color:'#0284c7' },
  '09:00-18:00': { bg:'rgba(22,163,74,.10)', color:'#16a34a' },
  '10:00-19:00': { bg:'rgba(5,150,105,.10)', color:'#059669' },
  '11:00-20:00': { bg:'rgba(124,58,237,.10)',color:'#7c3aed' },
  '12:00-21:00': { bg:'rgba(219,39,119,.10)',color:'#db2777' },
  '13:00-22:00': { bg:'rgba(220,38,38,.10)', color:'#dc2626' },
  '14:00-23:00': { bg:'rgba(185,28,28,.12)', color:'#b91c1c' },
  '22:00-07:00': { bg:'rgba(71,85,105,.08)', color:'#475569' },
};

const EMPRESA_COLORS = {
  'CALLYPSO':  { bg:'rgba(220,38,38,.10)',  color:'#dc2626', dot:'#dc2626' },
  'PRIMA':     { bg:'rgba(37,99,235,.10)',  color:'#2563eb', dot:'#2563eb' },
  'INTEGRAL':  { bg:'rgba(22,163,74,.10)',  color:'#16a34a', dot:'#16a34a' },
  'SIN DATA':  { bg:'rgba(255,255,255,.05)', color:'#a7acb1', dot:'#8d9296' },
};

/* Los badges comparten la clase .pill-badge (css/views.css); el color va en --bg / --fg */
const GD_NONE = '<span class="txt-light">—</span>';

function gdCountryBadge(val) {
  const v = (val || '').trim();
  if (!v || v === '—') return GD_NONE;
  return `<span class="pill-badge pill-badge--country">${escapeHtml(v)}</span>`;
}

function gdDayBadge(val) {
  const v = (val || '').toUpperCase().trim();
  if (!v || v === '—' || v === 'EMPTY') return GD_NONE;
  const c = DAY_COLORS[v] || { bg:'var(--main-bg)', color:'var(--text-mid)' };
  return `<span class="pill-badge" style="--bg:${c.bg};--fg:${c.color}">${escapeHtml(val)}</span>`;
}

function gdScheduleBadge(val) {
  const v = (val || '').trim();
  if (!v || v === '—') return GD_NONE;
  // Find matching key (partial match)
  const key = Object.keys(SCHEDULE_COLORS).find(k => v.includes(k.split('-')[0])) || '';
  const c = SCHEDULE_COLORS[key] || { bg:'var(--main-bg)', color:'var(--text-mid)' };
  return `<span class="pill-badge pill-badge--sched" style="--bg:${c.bg};--fg:${c.color}">${escapeHtml(val)}</span>`;
}

function gdEmpresaBadge(val) {
  const v = (val || '').toUpperCase().trim();
  if (!v || v === '—') return GD_NONE;
  const c = EMPRESA_COLORS[v] || { bg:'var(--main-bg)', color:'var(--text-mid)', dot:'var(--text-light)' };
  return `<span class="pill-badge pill-badge--emp" style="--bg:${c.bg};--fg:${c.color};--dot:${c.dot}"><i></i>${escapeHtml(val)}</span>`;
}

/* ══════════════════════════════
   EQUIPOS 360 — modelo de datos
══════════════════════════════ */
let eqOps = [];          // un registro por OP de la distribución (ver eqBuildOps)
let eqTLs = [];          // un registro por Team Leader (ver eqBuildTLs), ordenado por ranking de calidad
let eqErr = null;        // resultado de errFetch() o { error }
let eqAtt = null;        // resultado de attFetch() o { error }
let eqOpsIdxByNum = new Map(); // número de operador → filas de dt_ops (una por campaña)

/* Turnos: salen del HORARIO de cada OP (mismo criterio que Gestión de Recalls, recShiftBucket) */
const EQ_SHIFTS = [
  { key: 'AM',        label: 'AM',        icon: '🌅' },
  { key: 'Post-Sale', label: 'Post-Sale', icon: '🛍️' },
  { key: 'PM',        label: 'PM',        icon: '🌇' },
  { key: 'Nocturno',  label: 'Nocturno',  icon: '🌙' },
];

const EQ_PREFS_KEY = 'gc_eq_prefs';
let eqView   = 'tl';     // 'tl' | 'ops' | 'rank' | 'bono' | 'dia'
let eqPeriod = 'cur';    // 'cur' (mes actual) | 'prev' (mes anterior) | 'all' — periodo de los errores
let eqEvoMode = 'chart'; // 'chart' | 'cal' — cómo se ve "Evolución de errores" en las fichas
let eqDrawerWide = false; // ficha ampliada (casi pantalla completa)
let eqShift = null;      // turno de las vistas Bono y Por día: '' = todos · null = nunca elegido (se propone el del equipo)
let eqDiaMode = 'dia';   // vista Por día: 'dia' (días del mes) | 'mes' (meses)
(() => {
  try {
    const p = JSON.parse(localStorage.getItem(EQ_PREFS_KEY) || '{}');
    if (['tl', 'ops', 'rank', 'bono', 'dia'].includes(p.view)) eqView = p.view;
    if (ERR_PERIODS[p.period]) eqPeriod = p.period;
    if (['chart', 'cal'].includes(p.evo)) eqEvoMode = p.evo;
    eqDrawerWide = !!p.wide;
    if (p.shift === '' || EQ_SHIFTS.some(s => s.key === p.shift)) eqShift = p.shift;
    if (['dia', 'mes'].includes(p.diaMode)) eqDiaMode = p.diaMode;
  } catch { /* sin storage: se usan los valores por defecto */ }
})();
function eqSavePrefs() {
  try {
    localStorage.setItem(EQ_PREFS_KEY, JSON.stringify({
      view: eqView, period: eqPeriod, evo: eqEvoMode, wide: eqDrawerWide, shift: eqShift, diaMode: eqDiaMode,
    }));
  } catch { /* nada */ }
}

function eqNum(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

/* Campañas del OP según Approve Stats (dt_ops ya cargado por loadOps en window._opsIdx) */
function eqBuildOpsIndex() {
  eqOpsIdxByNum = new Map();
  const idx = window._opsIdx || {};
  Object.keys(idx).forEach(operator => {
    const num = sheetOperatorNumber(operator);
    if (!num) return;
    const list = eqOpsIdxByNum.get(num) || [];
    Object.entries(idx[operator] || {}).forEach(([country, r]) => {
      list.push({
        country,
        total: eqNum(r.Total) || 0,
        approve: eqNum(r.Approve) || 0,
        approvePct: eqNum(r['Approve (%)']),
        reject: eqNum(r.Reject) || 0,
        rejectPct: eqNum(r['Reject (%)']),
        trashPct: eqNum(r['Trash (%)']),
        avgPrice: r['Avg Price ($)'] === '' ? null : eqNum(r['Avg Price ($)']),
      });
    });
    eqOpsIdxByNum.set(num, list);
  });
}

function eqBuildOps(disRows) {
  const errByNum = eqErr && eqErr.records ? errGroupByNum(eqErr.records) : new Map();
  const seen = new Set();
  eqOps = [];
  (disRows || []).forEach(d => {
    const perop = (d.PEROP1AM || '').trim();
    const num = sheetOperatorNumber(perop);
    const key = num || perop;
    if (!key || seen.has(key)) return;
    seen.add(key);
    const campaigns = (num && eqOpsIdxByNum.get(num) || []).slice().sort((a, b) => b.total - a.total);
    const total = campaigns.reduce((s, c) => s + c.total, 0);
    const approve = campaigns.reduce((s, c) => s + c.approve, 0);
    const errors = (num && errByNum.get(num)) || [];
    // Bono de Check y Approve: errores de Verificación del mes actual (sin importar el periodo elegido)
    const verif = bonoMonthRecords(errors);
    const bono = bonoInfo(verif.length);
    const bonoBefore = bonoInfo(verif.filter(r => !errNewAt(r)).length);   // cómo estaba antes de los nuevos de hoy
    eqOps.push({
      key, num, perop,
      tl: (d.TEAMLEADER || '').trim() || '—',
      asesor: (d.ASESORES || '').trim() || perop,
      pais: (d.PAIS || '').trim(),
      descanso: (d.DESCANSO || '').trim(),
      horario: (d.HORARIO || '').trim(),
      shift: recShiftBucket(d.HORARIO),   // 'AM' | 'Post-Sale' | 'PM' | 'Nocturno' | null (sin horario)
      empresa: (d.EMPRESA || '').trim(),
      asistencia: (eqAtt && eqAtt.map && num) ? (eqAtt.map.get(num) || '') : '',
      campaigns, totalOrders: total, approve,
      approvePct: total > 0 ? (approve / total) * 100 : null,
      errors,
      alerts: errComputeAlerts(errors),
      newToday: errors.filter(r => errNewAt(r)),
      bono, bonoBeforePct: bonoBefore.pct, bonoUp: bono.pct > bonoBefore.pct,
    });
  });
  eqApplyPeriod();
}

/* Cuenta los errores del periodo elegido (y del periodo anterior, para la tendencia) */
function eqApplyPeriod() {
  const { start, end, prevStart, prevEnd } = errPeriodBounds(eqPeriod);
  eqOps.forEach(o => {
    o.errPeriod = o.errors.filter(r => errInRange(r, start, end));
    o.errPrevCount = start ? o.errors.filter(r => errInRange(r, prevStart, prevEnd)).length : null;
    o.errCount = o.errPeriod.length;
    o.errBySource = errCountBySource(o.errPeriod);
  });
  eqBuildTLs();
}

function eqBuildTLs() {
  const map = new Map();
  eqOps.forEach(o => {
    if (!map.has(o.tl)) map.set(o.tl, { tl: o.tl, ops: [] });
    map.get(o.tl).ops.push(o);
  });
  eqTLs = [...map.values()].filter(t => t.tl !== '—').map(t => {
    const ops = t.ops;
    const total = ops.reduce((s, o) => s + o.totalOrders, 0);
    const approve = ops.reduce((s, o) => s + o.approve, 0);
    const errCount = ops.reduce((s, o) => s + o.errCount, 0);
    const prev = ops.every(o => o.errPrevCount === null) ? null : ops.reduce((s, o) => s + (o.errPrevCount || 0), 0);
    const bySource = errCountBySource(ops.flatMap(o => o.errPeriod));
    const countries = {};
    ops.forEach(o => { if (o.pais) countries[o.pais] = (countries[o.pais] || 0) + 1; });
    const worst = [...ops].sort((a, b) => b.errCount - a.errCount)[0];
    return {
      ...t,
      size: ops.length,
      present: ops.filter(o => attIsPresent(o.asistencia)).length,
      countries,
      totalOrders: total, approve,
      approvePct: total > 0 ? (approve / total) * 100 : null,
      errCount, errPrevCount: prev, bySource,
      errPerOp: ops.length ? errCount / ops.length : 0,
      worst: worst && worst.errCount > 0 ? worst : null,
      alertOps: ops.filter(o => o.alerts.length).length,
      newToday: ops.reduce((s, o) => s + o.newToday.length, 0),
      bonoOps: ops.filter(o => o.bono.pct > 0).length,
    };
  });
  // Ranking de calidad: menos errores por OP primero (promedio según el tamaño ACTUAL del equipo); desempata el approve
  eqTLs.sort((a, b) => (a.errPerOp - b.errPerOp) || ((b.approvePct ?? -1) - (a.approvePct ?? -1)) || a.tl.localeCompare(b.tl));
  eqTLs.forEach((t, i) => { t.rank = i + 1; });
}

function eqFindOp(key) { return eqOps.find(o => o.key === key); }
function eqFindTL(name) { return eqTLs.find(t => t.tl === name); }

/* ══════════════════════════════
   CARGA
══════════════════════════════ */
/* silent = refresco automático (autoRefreshTick): sin spinner ni "Cargando…", conserva vista, filtros y panel abierto */
async function loadGoodDay(silent = false) {
  const spinIcon = document.getElementById('gd-spin-icon');
  spinIcon.classList.add('spin');
  if (!silent && !gdLoaded) document.getElementById('eq-loading').hidden = false;

  try {
    // Distribución (obligatoria) + asistencia, errores y Approve Stats (si alguno falla, lo demás igual se muestra)
    const [data, att, errs] = await Promise.all([
      sbFetchAll('dt_dis', `select=${GD_COLS.join(',')}&order=TEAMLEADER.asc,PEROP1AM.asc`),
      attFetch(true).catch(err => { console.error('Asistencia no disponible:', err); return { error: err }; }),
      errFetch(true).catch(err => { console.error('Errores no disponibles:', err); return { error: err }; }),
      bonoFetchTiers(),
      (typeof opsLoaded !== 'undefined' && opsLoaded) ? null : loadOps().catch(err => console.error('Approve Stats no disponible:', err)),
    ]);
    eqAtt = att;
    eqErr = errs;
    eqBuildOpsIndex();
    eqBuildOps(data);

    gdLoaded = true;
    document.getElementById('eq-loading').hidden = true;
    eqRenderStatus();
    eqPopulateFilters();
    eqRenderAll();
    if (eqDrawerStack.length) eqRenderDrawer();   // el panel abierto se refresca con la data nueva
    if (eqPendingNewDialog) { eqPendingNewDialog = false; eqOpenNewErrors(); }   // vino desde la campanita

    document.getElementById('gd-last-update').textContent =
      `Actualizado: ${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  } catch (err) {
    if (silent) { console.error('Error en refresco de Equipos 360:', err); return; }
    const box = document.getElementById('eq-loading');
    box.hidden = false;
    box.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
      <p>No se pudo cargar la distribución</p>
      <small>${escapeHtml(err.message)}</small>
      ${uiRetryButton('loadGoodDay()')}`;
  } finally {
    spinIcon.classList.remove('spin');
  }
}

/* Avisos de la barra: asistencia o hojas de errores que no se pudieron leer */
function eqRenderStatus() {
  const attWarn = document.getElementById('gd-att-warn');
  attWarn.hidden = !(eqAtt && eqAtt.error);
  if (eqAtt && eqAtt.error) attWarn.title = eqAtt.error.message || 'No se pudo leer la hoja de asistencia';

  const errWarn = document.getElementById('eq-err-warn');
  const failed = eqErr && eqErr.status ? ERR_SOURCES.filter(s => !eqErr.status[s.key].ok) : (eqErr && eqErr.error ? ERR_SOURCES : []);
  errWarn.hidden = failed.length === 0;
  errWarn.title = failed.map(s => `${s.full}: ${(eqErr.status && eqErr.status[s.key].error) || (eqErr.error && eqErr.error.message) || 'no disponible'}`).join('\n');
  errWarn.textContent = failed.length === ERR_SOURCES.length ? '⚠ Errores no disponibles' : `⚠ Sin datos de: ${failed.map(s => s.label).join(', ')}`;

  const legend = document.getElementById('gd-att-legend');
  if (!legend.innerHTML) legend.innerHTML = attLegendHTML();
}

/* ══════════════════════════════
   RENDER GENERAL
══════════════════════════════ */
function eqRenderAll() {
  eqSyncToolbar();
  eqRenderKPIs();
  document.getElementById('eq-view-tl').hidden = eqView !== 'tl';
  document.getElementById('eq-view-ops').hidden = eqView !== 'ops';
  document.getElementById('eq-view-rank').hidden = eqView !== 'rank';
  document.getElementById('eq-view-bono').hidden = eqView !== 'bono';
  document.getElementById('eq-view-dia').hidden = eqView !== 'dia';
  if (eqView === 'tl') eqRenderTLCards();
  if (eqView === 'ops') applyGDFilters();
  if (eqView === 'rank') eqRenderRanking();
  if (eqView === 'bono') eqRenderBono();
  if (eqView === 'dia') eqRenderDia();
}

function eqSetView(view) {
  eqView = view;
  eqSavePrefs();
  eqRenderAll();
}

function eqSetPeriod(period) {
  if (!ERR_PERIODS[period]) return;
  eqPeriod = period;
  eqSavePrefs();
  eqCalNav = 0;
  eqCalDay = null;
  if (ERR_PERIODS[period].offset !== null) eqDiaOffset = ERR_PERIODS[period].offset;   // "Por día" muestra ese mes
  eqApplyPeriod();
  eqRenderAll();
  if (eqDrawerStack.length) eqRenderDrawer();
}

function eqSyncToolbar() {
  document.querySelectorAll('.eq-view-btn').forEach(b => {
    const on = b.dataset.view === eqView;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.eq-period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === eqPeriod));
}

function eqPeriodLabel() { return errPeriodLabel(eqPeriod); }

/* Tendencia vs el periodo anterior (errPeriodBounds: mismos días del mes anterior / mes de antes) — para errores, bajar = bueno */
function eqTrendHTML(cur, prev) {
  if (prev === null || prev === undefined) return '';
  if (cur === prev) return `<span class="eq-trend eq-trend-flat" title="Igual que el periodo anterior">= ${prev}</span>`;
  const up = cur > prev;
  return `<span class="eq-trend ${up ? 'eq-trend-bad' : 'eq-trend-good'}" title="Periodo anterior: ${prev}">${up ? '▲' : '▼'} ${Math.abs(cur - prev)}</span>`;
}

/* onclick = KPI clicable (abre un detalle) */
function eqKpi(label, value, sub = '', cls = '', onclick = '') {
  const tag = onclick ? 'button' : 'div';
  return `<${tag} ${onclick ? `type="button" onclick="${onclick}"` : ''} class="kpi-card eq-kpi ${cls} ${onclick ? 'eq-kpi-click' : ''}">
    <div class="kpi-header"><span class="kpi-label">${label}</span>${onclick ? '<span class="eq-kpi-go">ver →</span>' : ''}</div>
    <div class="kpi-value">${value}</div>
    ${sub ? `<span class="kpi-sub">${sub}</span>` : ''}
  </${tag}>`;
}

function eqRenderKPIs() {
  const total = eqOps.length;
  const code = o => String(o.asistencia || '').trim().toUpperCase();
  const present = eqOps.filter(o => code(o) === 'A').length;
  const absent = eqOps.filter(o => ['FA', 'S'].includes(code(o))).length;
  const off = eqOps.filter(o => ['OFF', 'VA', 'DM'].includes(code(o))).length;
  const unmarked = eqOps.filter(o => !code(o)).length;
  const errCount = eqOps.reduce((s, o) => s + o.errCount, 0);
  const errPrev = eqOps.every(o => o.errPrevCount === null) ? null : eqOps.reduce((s, o) => s + (o.errPrevCount || 0), 0);
  const alertOps = eqOps.filter(o => o.alerts.length).length;
  const attOk = eqAtt && !eqAtt.error;
  const errOk = eqErr && !eqErr.error;

  document.getElementById('eq-kpis').innerHTML = [
    eqKpi('OPs en distribución', total.toLocaleString('es-PE'), `${eqTLs.length} Team Leaders`),
    eqKpi('Asistieron hoy', attOk ? present : '—', attOk ? `${total ? Math.round((present / total) * 100) : 0}% · ${unmarked} sin marcar` : 'asistencia no disponible', 'eq-kpi-green'),
    eqKpi('Faltas / suspensión', attOk ? absent : '—', 'FA y S en la hoja de asistencia', absent ? 'eq-kpi-red' : ''),
    eqKpi('Descanso / vacaciones', attOk ? off : '—', 'OFF, VA y DM'),
    eqKpi(`Errores (${eqPeriodLabel()})`, errOk ? errCount.toLocaleString('es-PE') : '—',
      errOk ? `${eqTrendHTML(errCount, errPrev)} ${errPrev !== null ? errPrevLabel(eqPeriod) : 'de los OPs actuales'}` : 'hojas de errores no disponibles', errCount ? 'eq-kpi-amber' : ''),
    eqKpi('OPs con alerta', errOk ? alertOps : '—', 'errores repetidos o en aumento (7 días)', alertOps ? 'eq-kpi-red' : ''),
    eqKpiNew(errOk),
    eqKpiBono(errOk),
  ].join('');
}

/* 🆕 Errores nuevos de hoy (memoria compartida, supabase/16) — clic = lista */
function eqKpiNew(errOk) {
  const seen = eqErr && eqErr.seen;
  if (!errOk || !seen || !seen.ok) {
    return eqKpi('🆕 Errores nuevos hoy', '—', seen && seen.missing ? 'falta correr el script 16 en Supabase' : 'no disponible por ahora');
  }
  const n = eqAllNewToday().length;
  const removed = seen.removed.length;
  const last = eqAllNewToday().reduce((m, r) => { const t = errNewAt(r); return t > m ? t : m; }, null);
  return eqKpi('🆕 Errores nuevos hoy', n.toLocaleString('es-PE'),
    n ? `el último a las ${errFmtTime(last)}${removed ? ` · ${removed} quitado${removed === 1 ? '' : 's'}` : ''}` : `ninguno por ahora${removed ? ` · ${removed} quitado${removed === 1 ? '' : 's'}` : ''}`,
    n ? 'eq-kpi-blue' : '', 'eqOpenNewErrors()');
}

/* 💸 OPs con descuento del bono (errores de Verificación del mes) — clic = vista Bono */
function eqKpiBono(errOk) {
  if (!errOk || !eqErr.status || !eqErr.status.verificacion || !eqErr.status.verificacion.ok) {
    return eqKpi('💸 Descuento del bono', '—', 'hoja de Verificación no disponible');
  }
  const withDisc = eqOps.filter(o => o.bono.pct > 0).length;
  const near = eqOps.filter(o => o.bono.faltan === 1).length;
  return eqKpi('💸 Descuento del bono', withDisc.toLocaleString('es-PE'),
    `OPs con descuento${near ? ` · ${near} a 1 error del siguiente tramo` : ''}`, withDisc ? 'eq-kpi-red' : '', "eqSetView('bono')");
}

/* Marcas junto al nombre de un OP: ⚠ alerta, 🆕 errores nuevos hoy, −X% descuento del bono */
function eqOpMarks(o) {
  return `${o.alerts.length ? ' <span class="eq-alert-flag" title="Tiene alertas de calidad">⚠</span>' : ''}`
    + `${o.newToday.length ? ` <span class="eq-new-pill" title="${o.newToday.length} error${o.newToday.length === 1 ? '' : 'es'} nuevo${o.newToday.length === 1 ? '' : 's'} hoy">🆕 ${o.newToday.length}</span>` : ''}`
    + `${o.bono.pct ? ` ${bonoBadge(o.bono)}` : ''}`;
}

/* Todos los errores nuevos de hoy (también de OPs que ya no están en la distribución) */
function eqAllNewToday() {
  return eqErr && eqErr.records ? eqErr.records.filter(r => errNewAt(r)) : [];
}

/* ══════════════════════════════
   PIEZAS VISUALES
══════════════════════════════ */
function eqInitials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0] || '').join('').toUpperCase();
}

function eqAvatar(name, big = false) {
  const c = recColorForName(name) || { bg: 'var(--card-bg-2)', color: 'var(--text-mid)' };
  return `<span class="eq-avatar ${big ? 'eq-avatar-lg' : ''}" style="--bg:${c.bg};--fg:${c.color}">${escapeHtml(eqInitials(name))}</span>`;
}

function eqApproveHTML(pct) {
  if (pct === null || pct === undefined) return '<span class="eq-muted">—</span>';
  return `<span class="rep-approve-badge ${repApproveClass(pct)}">${pct.toFixed(1)}%</span>`;
}

/* Barra apilada por hoja de errores */
function eqSourceBar(bySource, total) {
  if (!total) return `<div class="eq-srcbar eq-srcbar-empty"><span>Sin errores en el periodo</span></div>`;
  return `<div class="eq-srcbar" title="${ERR_SOURCES.map(s => `${s.label}: ${bySource[s.key] || 0}`).join(' · ')}">${
    ERR_SOURCES.filter(s => bySource[s.key]).map(s => `<span style="flex:${bySource[s.key]};background:${s.color}"></span>`).join('')
  }</div>`;
}

function eqSourceLegend(bySource) {
  return `<div class="eq-srclegend">${ERR_SOURCES.map(s =>
    `<span><i style="background:${s.color}"></i>${s.label} <strong>${bySource[s.key] || 0}</strong></span>`).join('')}</div>`;
}

/* Minigráfica de las últimas 8 semanas (lunes a domingo), SVG inline */
const EQ_SPARK_WEEKS = 8;
function eqWeekStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function eqWeeklyCounts(records, weeks = EQ_SPARK_WEEKS) {
  const thisWeek = eqWeekStart(new Date());
  const counts = Array(weeks).fill(0);
  records.forEach(r => {
    if (!r.date) return;
    const diff = Math.round((thisWeek - eqWeekStart(r.date)) / (7 * 86400000));
    if (diff >= 0 && diff < weeks) counts[weeks - 1 - diff]++;
  });
  return counts;
}
function eqSparkSVG(values) {
  const max = Math.max(1, ...values);
  const w = 8, gap = 3, h = 30;
  const bars = values.map((v, i) => {
    const bh = v ? Math.max(3, Math.round((v / max) * h)) : 2;
    const last = i === values.length - 1;
    return `<rect x="${i * (w + gap)}" y="${h - bh}" width="${w}" height="${bh}" rx="2" fill="${v ? (last ? 'var(--nav-accent)' : '#8b919a') : 'var(--border)'}"><title>${v} error${v === 1 ? '' : 'es'}</title></rect>`;
  }).join('');
  return `<svg class="eq-spark" viewBox="0 0 ${values.length * (w + gap) - gap} ${h}" width="${values.length * (w + gap) - gap}" height="${h}" aria-hidden="true">${bars}</svg>`;
}

function eqCountryChips(countries) {
  return Object.entries(countries).sort((a, b) => b[1] - a[1]).map(([c, n]) =>
    `<span class="eq-chip">${countryFlag(c)}${escapeHtml(c)} <strong>${n}</strong></span>`).join('');
}

/* ══════════════════════════════
   VISTA: POR TEAM LEADER (tarjetas)
══════════════════════════════ */
function eqRenderTLCards() {
  const grid = document.getElementById('eq-tl-grid');
  if (!eqTLs.length) {
    grid.innerHTML = `<div class="gd-state card-box"><p>No hay Team Leaders en la distribución</p><small>Sube la distribución desde "Actualización de Data"</small></div>`;
    return;
  }
  // Orden alfabético para ubicarse rápido; el puesto del ranking va como insignia
  grid.innerHTML = [...eqTLs].sort((a, b) => a.tl.localeCompare(b.tl)).map(t => `
    <article class="eq-tl-card" tabindex="0" role="button" onclick="eqOpenTL(${jsArg(t.tl)})"
      onkeydown="if(event.key==='Enter')eqOpenTL(${jsArg(t.tl)})" aria-label="Ver equipo de ${escapeHtml(t.tl)}">
      <header class="eq-tl-head">
        ${eqAvatar(t.tl)}
        <div class="eq-tl-id">
          <div class="eq-tl-name">${escapeHtml(t.tl)}</div>
          <div class="eq-muted">${t.size} OP${t.size === 1 ? '' : 's'} · ${eqAtt && !eqAtt.error ? `${t.present} asistieron hoy` : 'asistencia no disponible'}</div>
        </div>
        <span class="eq-rank-pill ${t.rank <= 3 ? `eq-rank-top eq-rank-${t.rank}` : ''}" title="Puesto en el ranking de calidad (errores por OP)">#${t.rank}</span>
      </header>
      <div class="eq-chips">${eqCountryChips(t.countries) || '<span class="eq-muted">Sin campaña asignada</span>'}</div>
      <div class="eq-tl-stats">
        <div><span class="eq-stat-lbl" title="Approve Stats, últimos 90 días">Approve</span><span class="eq-stat-val">${eqApproveHTML(t.approvePct)}</span></div>
        <div><span class="eq-stat-lbl">Errores</span><span class="eq-stat-val">${t.errCount} ${eqTrendHTML(t.errCount, t.errPrevCount)}</span></div>
        <div><span class="eq-stat-lbl">Errores / OP</span><span class="eq-stat-val">${t.errPerOp.toFixed(1)}</span></div>
      </div>
      ${eqSourceBar(t.bySource, t.errCount)}
      <footer class="eq-tl-foot">
        <div class="eq-tl-spark" title="Errores por semana (últimas ${EQ_SPARK_WEEKS})">${eqSparkSVG(eqWeeklyCounts(t.ops.flatMap(o => o.errors)))}<span class="eq-muted eq-nowrap">8 sem.</span></div>
        <div class="eq-tl-worst">${t.worst ? `Más errores: <strong>${escapeHtml(t.worst.asesor)}</strong> (${t.worst.errCount})` : '<span class="eq-muted">Sin errores en el periodo 🎉</span>'}</div>
      </footer>
      ${t.newToday ? `<div class="eq-tl-new">🆕 ${t.newToday} error${t.newToday === 1 ? '' : 'es'} nuevo${t.newToday === 1 ? '' : 's'} hoy</div>` : ''}
      ${t.alertOps ? `<div class="eq-tl-alert">⚠ ${t.alertOps} OP${t.alertOps === 1 ? '' : 's'} con alerta</div>` : ''}
      ${t.bonoOps ? `<div class="eq-tl-bono">💸 ${t.bonoOps} OP${t.bonoOps === 1 ? '' : 's'} con descuento del bono</div>` : ''}
    </article>`).join('');
}

/* ══════════════════════════════
   VISTA: TODOS LOS OPs (tabla con filtros)
══════════════════════════════ */
const GD_ATT_EMPTY = '__sin_marcar__'; // valor del filtro "Sin marcar" (asistencia vacía)
const EQ_OP_COLS = [
  { key: 'tl',         label: 'Team Leader' },
  { key: 'asesor',     label: 'Operador' },
  { key: 'pais',       label: 'Campaña' },
  { key: 'descanso',   label: 'Descanso' },
  { key: 'horario',    label: 'Horario' },
  { key: 'empresa',    label: 'Empresa' },
  { key: 'asistencia', label: 'Asistencia' },
  { key: 'approvePct', label: 'Approve (90 d)', num: true },
  { key: 'errCount',   label: 'Errores', num: true },
];
let eqOpSort = { key: 'tl', dir: 1 };
let eqOpFiltered = [];

function eqPopulateFilters() {
  const unique = key => [...new Set(eqOps.map(o => o[key]).filter(Boolean))].sort();
  const fill = (id, values, allLabel = 'Todos') => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = `<option value="">${allLabel}</option>` + values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if (prev && values.includes(prev)) sel.value = prev;
  };
  fill('gd-f-tl', unique('tl'));
  fill('gd-f-camp', unique('pais'));
  fill('gd-f-emp', unique('empresa'), 'Todas');
  fill('gd-f-hor', unique('horario'));
  fill('gd-f-desc', unique('descanso'));

  // Asistencia: el valor es el código de la hoja (A, OFF, Fa…); el texto agrega su significado
  const asisSel = document.getElementById('gd-f-asis');
  const prev = asisSel.value;
  const codes = unique('asistencia');
  asisSel.innerHTML = '<option value="">Todos</option>' + codes.map(v => {
    const meaning = attMeaning(v);
    return `<option value="${escapeHtml(v)}">${escapeHtml(meaning ? `${v} — ${meaning}` : v)}</option>`;
  }).join('') + (eqOps.some(o => !o.asistencia) ? `<option value="${GD_ATT_EMPTY}">Sin marcar</option>` : '');
  if (prev && (codes.includes(prev) || prev === GD_ATT_EMPTY)) asisSel.value = prev;
}

function applyGDFilters() {
  const v = id => document.getElementById(id).value;
  const tl = v('gd-f-tl'), camp = v('gd-f-camp'), emp = v('gd-f-emp'), hor = v('gd-f-hor'), desc = v('gd-f-desc'), asis = v('gd-f-asis');
  const onlyErr = document.getElementById('gd-f-onlyerr').checked;
  const search = document.getElementById('gd-search').value.trim().toLowerCase();

  eqOpFiltered = eqOps.filter(o => {
    if (tl && o.tl !== tl) return false;
    if (camp && o.pais !== camp) return false;
    if (emp && o.empresa !== emp) return false;
    if (hor && o.horario !== hor) return false;
    if (desc && o.descanso !== desc) return false;
    if (asis && (asis === GD_ATT_EMPTY ? o.asistencia !== '' : o.asistencia !== asis)) return false;
    if (onlyErr && !o.errCount && !o.alerts.length) return false;
    if (search && !`${o.asesor} ${o.perop}`.toLowerCase().includes(search)) return false;
    return true;
  });

  const pills = { 'pill-tl': tl, 'pill-camp': camp, 'pill-emp': emp, 'pill-hor': hor, 'pill-desc': desc, 'pill-asis': asis };
  Object.entries(pills).forEach(([id, val]) => document.getElementById(id)?.classList.toggle('active', !!val));
  const anyActive = Object.values(pills).some(Boolean) || !!search || onlyErr;
  document.getElementById('gd-clear-btn').style.display = anyActive ? 'flex' : 'none';
  document.querySelector('#view-goodday .gd-search-wrap')?.classList.toggle('active', !!search);

  renderGDTable();
}

function clearGDFilters() {
  ['gd-f-tl','gd-f-camp','gd-f-emp','gd-f-hor','gd-f-desc','gd-f-asis'].forEach(id => { document.getElementById(id).value = ''; });
  document.getElementById('gd-search').value = '';
  document.getElementById('gd-f-onlyerr').checked = false;
  applyGDFilters();
}

function clearPill(selectId) {
  document.getElementById(selectId).value = '';
  applyGDFilters();
}

function sortGD(key) {
  eqOpSort = eqOpSort.key === key ? { key, dir: -eqOpSort.dir } : { key, dir: EQ_OP_COLS.find(c => c.key === key)?.num ? -1 : 1 };
  renderGDTable();
}

function renderGDTable() {
  const table = document.getElementById('gd-table');
  const empty = document.getElementById('gd-empty');
  document.getElementById('gd-count').textContent = `${eqOpFiltered.length} de ${eqOps.length}`;

  const { key, dir } = eqOpSort;
  const rows = [...eqOpFiltered].sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'number' || typeof vb === 'number') return ((va ?? -1) - (vb ?? -1)) * dir;
    return String(va || '').localeCompare(String(vb || '')) * dir;
  });

  document.getElementById('gd-thead-row').innerHTML = EQ_OP_COLS.map(c => {
    const on = c.key === key;
    return `<th class="${on ? 'sorted' : ''} ${c.num ? 'eq-num' : ''}" onclick="sortGD('${c.key}')">${c.label} <span class="sort-icon">${on ? (dir > 0 ? '↑' : '↓') : '↕'}</span></th>`;
  }).join('');

  if (!rows.length) { table.style.display = 'none'; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';
  table.style.display = 'table';

  document.getElementById('gd-tbody').innerHTML = rows.map(o => `
    <tr class="eq-row" onclick="eqOpenOP(${jsArg(o.key)})" title="Ver ficha de ${escapeHtml(o.asesor)}">
      <td>${recTlBadge(o.tl)}</td>
      <td><div class="eq-op-cell">${eqAvatar(o.asesor)}<div><div class="eq-op-name">${escapeHtml(o.asesor)}${eqOpMarks(o)}</div><div class="eq-muted">${escapeHtml(o.perop)}</div></div></div></td>
      <td class="eq-nowrap">${o.pais ? `${countryFlag(o.pais)}${escapeHtml(o.pais)}` : '<span class="eq-muted">—</span>'}${o.campaigns.length > 1 ? `<span class="eq-more" title="${escapeHtml(o.campaigns.map(c => c.country).join(', '))}">+${o.campaigns.length - 1}</span>` : ''}</td>
      <td>${gdDayBadge(o.descanso)}</td>
      <td class="eq-nowrap">${gdScheduleBadge(o.horario)}</td>
      <td class="eq-nowrap">${gdEmpresaBadge(o.empresa)}</td>
      <td>${attBadge(o.asistencia)}</td>
      <td class="eq-num">${eqApproveHTML(o.approvePct)}</td>
      <td class="eq-num">${o.errCount ? `<span class="eq-err-count" title="${ERR_SOURCES.map(s => `${s.label}: ${o.errBySource[s.key]}`).join(' · ')}">${o.errCount}</span>` : '<span class="eq-muted">0</span>'}</td>
    </tr>`).join('');
}

/* ══════════════════════════════
   VISTA: RANKING DE CALIDAD (Team Leaders)
══════════════════════════════ */
function eqRenderRanking() {
  const tbody = document.getElementById('eq-rank-tbody');
  document.getElementById('eq-rank-period').textContent = eqPeriodLabel();
  if (!eqTLs.length) { tbody.innerHTML = `<tr><td colspan="9" class="td-empty">Sin Team Leaders</td></tr>`; return; }
  const maxPerOp = Math.max(0.1, ...eqTLs.map(t => t.errPerOp));
  tbody.innerHTML = eqTLs.map(t => `
    <tr class="eq-row" onclick="eqOpenTL(${jsArg(t.tl)})">
      <td><span class="eq-rank-pill ${t.rank <= 3 ? `eq-rank-top eq-rank-${t.rank}` : ''}">#${t.rank}</span></td>
      <td><div class="eq-op-cell">${eqAvatar(t.tl)}<span class="eq-op-name">${escapeHtml(t.tl)}</span></div></td>
      <td class="eq-num">${t.size}</td>
      <td class="eq-num">${t.errCount} ${eqTrendHTML(t.errCount, t.errPrevCount)}</td>
      <td class="eq-perop-cell">
        <div class="eq-perop-bar"><span style="width:${Math.max(3, (t.errPerOp / maxPerOp) * 100)}%"></span></div>
        <strong>${t.errPerOp.toFixed(2)}</strong>
      </td>
      ${ERR_SOURCES.map(s => `<td class="eq-num eq-th-${s.key}">${t.bySource[s.key] || 0}</td>`).join('')}
      <td class="eq-num">${eqApproveHTML(t.approvePct)}</td>
    </tr>`).join('');
}

/* ══════════════════════════════
   PANEL LATERAL — ficha del OP / del Team Leader
══════════════════════════════ */
let eqDrawerStack = [];      // [{ type: 'op'|'tl', id }] — "← Volver" regresa al anterior
let eqDrawerChart = null;
let eqDrawerErrFilter = 'all';
let eqDrawerErrLimit = 25;

function eqOpenOP(key) {
  if (!eqFindOp(key)) return;
  eqPushDrawer({ type: 'op', id: key });
}
function eqOpenTL(name) {
  if (!eqFindTL(name)) return;
  eqPushDrawer({ type: 'tl', id: name });
}
function eqPushDrawer(entry) {
  const top = eqDrawerStack[eqDrawerStack.length - 1];
  if (!(top && top.type === entry.type && top.id === entry.id)) eqDrawerStack.push(entry);
  eqDrawerErrFilter = 'all';
  eqDrawerErrLimit = 25;
  eqCalResetState();
  eqRenderDrawer();
  const drawer = document.getElementById('eq-drawer');
  eqSyncDrawerWidth();
  if (!drawer.classList.contains('open')) {
    drawer.classList.add('open');
    document.getElementById('eq-drawer-backdrop').classList.add('open');
    document.body.classList.add('eq-drawer-lock');
    setTimeout(() => document.getElementById('eq-drawer-close').focus(), 50);
  }
  document.getElementById('eq-drawer-body').scrollTop = 0;
}
function eqDrawerBack() {
  eqDrawerStack.pop();
  if (!eqDrawerStack.length) { eqCloseDrawer(); return; }
  eqDrawerErrFilter = 'all';
  eqCalResetState();
  eqRenderDrawer();
}
function eqCloseDrawer() {
  eqDrawerStack = [];
  document.getElementById('eq-drawer').classList.remove('open');
  document.getElementById('eq-drawer-backdrop').classList.remove('open');
  document.body.classList.remove('eq-drawer-lock');
  if (eqDrawerChart) { eqDrawerChart.destroy(); eqDrawerChart = null; }
}
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && eqDrawerStack.length && !document.querySelector('.ui-modal-overlay')) eqCloseDrawer();
});

function eqRenderDrawer() {
  const top = eqDrawerStack[eqDrawerStack.length - 1];
  if (!top) return;
  document.getElementById('eq-drawer-back').hidden = eqDrawerStack.length < 2;
  const body = document.getElementById('eq-drawer-body');
  if (eqDrawerChart) { eqDrawerChart.destroy(); eqDrawerChart = null; }
  if (top.type === 'op') {
    const o = eqFindOp(top.id);
    if (!o) { eqCloseDrawer(); return; }
    document.getElementById('eq-drawer-title').textContent = 'Ficha del OP';
    body.innerHTML = eqOpDrawerHTML(o);
    eqRenderEvo();
  } else {
    const t = eqFindTL(top.id);
    if (!t) { eqCloseDrawer(); return; }
    document.getElementById('eq-drawer-title').textContent = 'Equipo';
    body.innerHTML = eqTlDrawerHTML(t);
    eqRenderEvo();
  }
}

function eqTile(label, value, sub = '', style = '') {
  return `<div class="eq-tile" style="${style}"><span class="eq-tile-lbl">${label}</span><span class="eq-tile-val">${value}</span>${sub ? `<span class="eq-tile-sub">${sub}</span>` : ''}</div>`;
}

function eqSourceTiles(bySource) {
  return ERR_SOURCES.map(s => eqTile(s.label, bySource[s.key] || 0, '', `--src:${s.color}`)).join('');
}

function eqAlertsBox(alerts) {
  if (!alerts.length) return '';
  return `<div class="eq-dsec eq-alertbox">${alerts.map(a => `
    <div class="eq-alert-inline eq-alert--${a.level}"><span class="eq-alert-dot"></span><div><strong>${escapeHtml(a.title)}.</strong> ${escapeHtml(a.text)}</div></div>`).join('')}</div>`;
}

/* Ficha del OP: descuento del Bono de Check y Approve (errores de Verificación del mes actual) */
function eqBonoTile(o) {
  const verifOk = eqErr && eqErr.status && eqErr.status.verificacion && eqErr.status.verificacion.ok;
  if (!verifOk) return eqTile(`💸 ${BONO_NAME}`, '—', 'hoja de Verificación no disponible', 'grid-column:span 2');
  const next = bonoNextText(o.bono);
  const sub = `${o.bono.count} error${o.bono.count === 1 ? '' : 'es'} de Verificación en ${errPeriodLabel('cur')}${next ? ` · ${o.bono.faltan === 1 ? `<strong class="txt-low">${next}</strong>` : next}` : ''}`;
  return eqTile(`💸 ${BONO_NAME}`, o.bono.pct ? `<span class="bono-val bono-${bonoLevel(o.bono.pct)}">−${o.bono.pct}%</span>` : '<span class="txt-ok">Sin descuento</span>',
    sub, `grid-column:span 2;${o.bono.pct ? '--src:var(--red)' : ''}`);
}

/* Aviso de errores nuevos de hoy dentro de una ficha (team = muestra de quién es cada uno) */
function eqNewBox(records, team = false) {
  if (!records.length) return '';
  const times = [...new Set(records.map(r => errFmtTime(errNewAt(r))))].sort();
  const who = team ? [...new Set(records.map(r => { const o = eqOps.find(x => x.num === r.num); return o ? o.asesor : r.perop; }))] : [];
  return `<div class="eq-dsec eq-newbox">🆕 <strong>${records.length} error${records.length === 1 ? '' : 'es'} nuevo${records.length === 1 ? '' : 's'} hoy</strong>
    <span class="eq-muted">· detectado${records.length === 1 ? '' : 's'} a las ${times.join(', ')}${who.length ? ` · ${escapeHtml(who.slice(0, 4).join(', '))}${who.length > 4 ? ` y ${who.length - 4} más` : ''}` : ''}</span>
    <button type="button" class="btn btn-ghost btn-sm" onclick="eqSetDrawerErrFilter('new');document.getElementById('eq-errlist-box').scrollIntoView({behavior:'smooth',block:'start'})">Ver cuáles →</button>
  </div>`;
}

function eqTopTypesHTML(records) {
  const top = errTopTypes(records, 8);
  if (!top.length) return '<div class="eq-muted eq-empty-line">Sin errores en el periodo 🎉</div>';
  const max = top[0].count;
  return `<div class="eq-types">${top.map(t => {
    const s = errSource(t.source);
    return `<div class="eq-type">
      <div class="eq-type-head"><span class="eq-type-name" title="${escapeHtml(t.type)}">${escapeHtml(t.type)}</span><span class="eq-type-count">${t.count}</span></div>
      <div class="eq-type-bar"><span style="width:${(t.count / max) * 100}%;background:${s.color}"></span></div>
      <div class="eq-type-meta">${errSourceBadge(t.source)} <span class="eq-muted">último: ${errFmtDate(t.last)}</span></div>
    </div>`;
  }).join('')}</div>`;
}

function eqCampaignsTable(campaigns, currentPais) {
  if (!campaigns.length) return '<div class="eq-muted eq-empty-line">Sin datos en Approve Stats (BI-04, últimos 90 días).</div>';
  const cur = repCountryKey(currentPais);
  return `<div class="tbl-wrap"><table class="eq-dtable">
    <thead><tr><th>Campaña</th><th class="eq-num">Total</th><th class="eq-num">Approve</th><th class="eq-num">Approve %</th><th class="eq-num">Reject %</th><th class="eq-num">Trash %</th><th class="eq-num">Avg Price</th></tr></thead>
    <tbody>${campaigns.map(c => `<tr class="${repCountryKey(c.country) === cur ? 'eq-current' : ''}">
      <td class="eq-nowrap">${countryFlag(c.country)}${escapeHtml(c.country)}${repCountryKey(c.country) === cur ? ' <span class="eq-tag">actual</span>' : ''}</td>
      <td class="eq-num">${c.total.toLocaleString('es-PE')}</td>
      <td class="eq-num">${c.approve.toLocaleString('es-PE')}</td>
      <td class="eq-num">${eqApproveHTML(c.approvePct)}</td>
      <td class="eq-num">${c.rejectPct !== null ? c.rejectPct.toFixed(1) + '%' : '—'}</td>
      <td class="eq-num">${c.trashPct !== null ? c.trashPct.toFixed(1) + '%' : '—'}</td>
      <td class="eq-num">${c.avgPrice !== null ? '$' + c.avgPrice.toFixed(2) : '—'}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

/* showOp = lista del EQUIPO: cada error dice qué OP lo cometió (nombre + PEROP1AM, clic = su ficha) */
function eqErrListHTML(records, showOp = false) {
  const opByNum = showOp ? new Map(eqOps.filter(o => o.num).map(o => [o.num, o])) : null;
  const fresh = records.filter(r => errNewAt(r));
  if (eqDrawerErrFilter === 'new' && !fresh.length) eqDrawerErrFilter = 'all';
  const filtered = eqDrawerErrFilter === 'all' ? records
    : eqDrawerErrFilter === 'new' ? fresh
    : records.filter(r => r.source === eqDrawerErrFilter);
  const counts = errCountBySource(records);
  const chips = [['all', `Todos (${records.length})`], ...(fresh.length ? [['new', `🆕 Nuevos hoy (${fresh.length})`]] : []), ...ERR_SOURCES.map(s => [s.key, `${s.label} (${counts[s.key] || 0})`])]
    .map(([k, l]) => `<button type="button" class="eq-fchip ${k === 'new' ? 'eq-fchip-new' : ''} ${eqDrawerErrFilter === k ? 'active' : ''}" onclick="eqSetDrawerErrFilter('${k}')">${l}</button>`).join('');
  const shown = filtered.slice(0, eqDrawerErrLimit);
  const rows = shown.map(r => eqErrRowHTML(r, showOp ? opByNum : null)).join('');
  return `<div class="eq-fchips">${chips}</div>
    ${shown.length ? `<div class="eq-errlist">${rows}</div>` : '<div class="eq-muted eq-empty-line">Sin errores en el periodo 🎉</div>'}
    ${filtered.length > shown.length ? `<button type="button" class="btn btn-ghost btn-sm eq-more-btn" onclick="eqShowMoreErrors()">Ver ${Math.min(25, filtered.length - shown.length)} más (${filtered.length - shown.length} restantes)</button>` : ''}`;
}

/* Textos de un error, en todos los lugares donde se listan (fichas, calendario, Por día, Errores nuevos):
   · detail = DETALLE DEL FALLO (Gestión) o el comentario del asesor (Tipificación)
   · extra  = EXPLICACIÓN DEL FALLO (Gestión): suele ser larga → si pasa de unas líneas, va desplegable con un adelanto */
const EQ_EXTRA_SHORT = 180;
function eqErrTextHTML(r) {
  const detail = r.detail
    ? `<div class="eq-err-detail">${r.source === 'tipificacion' ? '<span class="eq-err-lbl">Comentario del asesor:</span> ' : ''}${escapeHtml(r.detail)}</div>` : '';
  if (!r.extra) return detail;
  const text = r.extra.trim();
  if (text.length <= EQ_EXTRA_SHORT && text.split('\n').length <= 3) {
    return `${detail}<div class="eq-err-extra"><span class="eq-err-lbl">Explicación:</span> ${escapeHtml(text)}</div>`;
  }
  const preview = text.replace(/\s+/g, ' ').slice(0, 110);
  return `${detail}<details class="eq-err-xdet">
    <summary><span class="eq-err-lbl">📝 Explicación</span> <span class="eq-err-xprev">${escapeHtml(preview)}…</span><span class="eq-err-xmore">ver completa</span></summary>
    <div class="eq-err-extra">${escapeHtml(text)}</div>
  </details>`;
}

/* Una fila de error. opByNum (Map num → OP) = mostrar quién lo cometió */
function eqErrRowHTML(r, opByNum = null) {
  const linkable = r.orderId && /^\d{6,}$/.test(r.orderId) && r.source !== 'verificacion';
  const fresh = errNewAt(r);
  return `<div class="eq-err ${fresh ? 'is-new' : ''}">
    <div class="eq-err-date">${errFmtDate(r.date, true)}${fresh ? `<span class="eq-new-tag" title="Apareció en la hoja hoy a las ${errFmtTime(fresh)}">NUEVO · ${errFmtTime(fresh)}</span>` : ''}</div>
    <div class="eq-err-main">
      ${opByNum ? eqErrOpLine(r, opByNum.get(r.num)) : ''}
      <div class="eq-err-type">${errSourceBadge(r.source)} ${escapeHtml(r.type)}</div>
      ${eqErrTextHTML(r)}
    </div>
    <div class="eq-err-order">${r.orderId ? (linkable
      ? `<button type="button" class="btn btn-ghost btn-sm rec-link-trigger" onclick="recOpenLinkMenu(event,${jsArg(r.orderId)})" title="Abrir la orden (Change / View)">#${escapeHtml(r.orderId)} ▾</button>`
      : `<span class="eq-muted">#${escapeHtml(r.orderId)}</span>`) : ''}</div>
  </div>`;
}

function eqErrOpLine(r, o) {
  const name = o ? o.asesor : 'Fuera de la distribución';
  const perop = o ? o.perop : r.perop;
  const inner = `${eqAvatar(name)}<span class="eq-err-op-name">${escapeHtml(name)}</span>${perop ? `<span class="eq-err-op-perop">${escapeHtml(perop)}</span>` : ''}`;
  return o
    ? `<button type="button" class="eq-err-op" onclick="eqOpenOP(${jsArg(o.key)})" title="Ver ficha de ${escapeHtml(name)}">${inner}</button>`
    : `<span class="eq-err-op">${inner}</span>`;
}

function eqSetDrawerErrFilter(k) { eqDrawerErrFilter = k; eqDrawerErrLimit = 25; eqRefreshErrList(); }
function eqShowMoreErrors() { eqDrawerErrLimit += 25; eqRefreshErrList(); }
function eqRefreshErrList() {
  const top = eqDrawerStack[eqDrawerStack.length - 1];
  const box = document.getElementById('eq-errlist-box');
  if (!top || !box) return;
  const records = top.type === 'op' ? eqFindOp(top.id).errPeriod : eqFindTL(top.id).ops.flatMap(o => o.errPeriod).sort((a, b) => (b.date || 0) - (a.date || 0));
  box.innerHTML = eqErrListHTML(records, top.type === 'tl');
}

function eqOpDrawerHTML(o) {
  const errOk = eqErr && !eqErr.error;
  return `
  <div class="eq-capture" id="eq-capture">
    <section class="eq-dhead">
      ${eqAvatar(o.asesor, true)}
      <div class="eq-dhead-id">
        <h3 class="eq-dname">${escapeHtml(o.asesor)}</h3>
        <div class="eq-muted">${escapeHtml(o.perop)}</div>
        <div class="eq-dbadges">
          ${recTlBadge(o.tl)} ${o.pais ? `<span class="eq-chip">${countryFlag(o.pais)}${escapeHtml(o.pais)}</span>` : ''}
          ${gdScheduleBadge(o.horario)} ${o.descanso ? `<span class="eq-muted">Descansa:</span> ${gdDayBadge(o.descanso)}` : ''} ${gdEmpresaBadge(o.empresa)}
        </div>
      </div>
      <div class="eq-dhead-att"><span class="eq-muted">Hoy</span>${attBadge(o.asistencia)}</div>
    </section>

    <section class="eq-tiles">
      ${eqTile(`Errores · ${eqPeriodLabel()}`, errOk ? o.errCount : '—', errOk ? `${eqTrendHTML(o.errCount, o.errPrevCount)} ${o.errPrevCount !== null ? errPrevLabel(eqPeriod) : ''}` : 'no disponible', 'grid-column:span 2')}
      ${eqSourceTiles(o.errBySource)}
      ${eqTile('Approve (90 d)', eqApproveHTML(o.approvePct), o.totalOrders ? `${o.approve} de ${o.totalOrders.toLocaleString('es-PE')} órdenes` : 'sin datos')}
      ${eqBonoTile(o)}
    </section>

    ${eqNewBox(o.newToday)}
    ${eqAlertsBox(o.alerts)}

    <section class="eq-dsec">
      <h4 class="eq-dsec-title">Campañas <span class="eq-muted">· Approve Stats, últimos 90 días</span></h4>
      ${eqCampaignsTable(o.campaigns, o.pais)}
    </section>

    ${eqEvoSectionHTML('Evolución de errores')}

    <section class="eq-dsec">
      <h4 class="eq-dsec-title">Errores que más se repiten <span class="eq-muted">· ${eqPeriodLabel()}</span></h4>
      ${eqTopTypesHTML(o.errPeriod)}
    </section>
  </div>

  <section class="eq-dsec">
    <h4 class="eq-dsec-title">Detalle de errores <span class="eq-muted">· ${eqPeriodLabel()}</span></h4>
    <div id="eq-errlist-box">${eqErrListHTML(o.errPeriod)}</div>
  </section>`;
}

/* Columna "Errores por hoja" de la tabla del equipo: barra apilada + los 3 números con su color */
function eqTeamErrCell(o) {
  if (!o.errCount) return '<span class="eq-team-clean">✓ Sin errores</span>';
  return `<div class="eq-team-err">
    <div class="eq-srcbar">${ERR_SOURCES.filter(s => o.errBySource[s.key]).map(s => `<span style="flex:${o.errBySource[s.key]};background:${s.color}"></span>`).join('')}</div>
    <div class="eq-team-err-nums">${ERR_SOURCES.map(s => `<span class="${o.errBySource[s.key] ? '' : 'is-zero'}" style="--src:${s.color}" title="${escapeHtml(s.full)}"><i></i>${o.errBySource[s.key] || 0}</span>`).join('')}</div>
  </div>`;
}

function eqTlDrawerHTML(t) {
  const errOk = eqErr && !eqErr.error;
  const records = t.ops.flatMap(o => o.errPeriod).sort((a, b) => (b.date || 0) - (a.date || 0));
  // Campañas del equipo: OPs asignados (distribución) + rendimiento del equipo en esa campaña (Approve Stats)
  const camp = new Map();
  t.ops.forEach(o => {
    if (o.pais) { const c = camp.get(o.pais) || { country: o.pais, ops: 0, total: 0, approve: 0 }; c.ops++; camp.set(o.pais, c); }
    o.campaigns.forEach(c => {
      const key = [...camp.keys()].find(k => repCountryKey(k) === repCountryKey(c.country)) || c.country;
      const cur = camp.get(key) || { country: c.country, ops: 0, total: 0, approve: 0 };
      cur.total += c.total; cur.approve += c.approve;
      camp.set(key, cur);
    });
  });
  const campRows = [...camp.values()].sort((a, b) => b.ops - a.ops || b.total - a.total);
  const alerts = t.ops.flatMap(o => o.alerts.map(a => ({ ...a, op: o })));
  const members = [...t.ops].sort((a, b) => b.errCount - a.errCount || a.asesor.localeCompare(b.asesor));

  return `
  <div class="eq-capture" id="eq-capture">
    <section class="eq-dhead">
      ${eqAvatar(t.tl, true)}
      <div class="eq-dhead-id">
        <h3 class="eq-dname">${escapeHtml(t.tl)}</h3>
        <div class="eq-muted">Team Leader · ${t.size} OP${t.size === 1 ? '' : 's'} en la distribución</div>
        <div class="eq-dbadges">${eqCountryChips(t.countries)}</div>
      </div>
      <div class="eq-dhead-att"><span class="eq-muted">Ranking de calidad</span><span class="eq-rank-pill eq-rank-lg ${t.rank <= 3 ? `eq-rank-top eq-rank-${t.rank}` : ''}">#${t.rank} de ${eqTLs.length}</span></div>
    </section>

    <section class="eq-tiles">
      ${eqTile(`Errores · ${eqPeriodLabel()}`, errOk ? t.errCount : '—', errOk ? `${eqTrendHTML(t.errCount, t.errPrevCount)} ${t.errPrevCount !== null ? errPrevLabel(eqPeriod) : ''}` : 'no disponible', 'grid-column:span 2')}
      ${eqTile('Errores / OP', t.errPerOp.toFixed(2), `promedio de sus ${t.size} OPs`)}
      ${eqTile('Asistieron hoy', eqAtt && !eqAtt.error ? `${t.present}/${t.size}` : '—')}
      ${eqTile('Approve (90 d)', eqApproveHTML(t.approvePct), t.totalOrders ? `${t.approve.toLocaleString('es-PE')} de ${t.totalOrders.toLocaleString('es-PE')}` : 'sin datos')}
      ${eqTile('OPs con alerta', t.alertOps, '', t.alertOps ? '--src:var(--red)' : '')}
      ${eqTile('💸 Con descuento del bono', t.bonoOps, `de ${t.size} OPs · ${errPeriodLabel('cur')}`, t.bonoOps ? '--src:var(--red)' : '')}
    </section>
    ${eqSourceLegend(t.bySource)}

    ${eqNewBox(t.ops.flatMap(o => o.newToday), true)}

    ${eqAlertsBox(alerts.map(a => ({ ...a, text: `${a.op.asesor}: ${a.text}` })))}

    <section class="eq-dsec">
      <h4 class="eq-dsec-title">Campañas del equipo <span class="eq-muted">· OPs asignados hoy y approve del equipo (90 días)</span></h4>
      <div class="tbl-wrap"><table class="eq-dtable">
        <thead><tr><th>Campaña</th><th class="eq-num">OPs asignados</th><th class="eq-num">Órdenes (90 d)</th><th class="eq-num">Approve %</th></tr></thead>
        <tbody>${campRows.map(c => `<tr>
          <td class="eq-nowrap">${countryFlag(c.country)}${escapeHtml(c.country)}</td>
          <td class="eq-num">${c.ops || '<span class="eq-muted">—</span>'}</td>
          <td class="eq-num">${c.total ? c.total.toLocaleString('es-PE') : '—'}</td>
          <td class="eq-num">${eqApproveHTML(c.total ? (c.approve / c.total) * 100 : null)}</td>
        </tr>`).join('') || '<tr><td colspan="4" class="eq-muted">Sin campañas</td></tr>'}</tbody>
      </table></div>
    </section>

    ${eqEvoSectionHTML('Evolución de errores del equipo')}

    <section class="eq-dsec">
      <h4 class="eq-dsec-title">Errores más comunes del equipo <span class="eq-muted">· ${eqPeriodLabel()}</span></h4>
      ${eqTopTypesHTML(records)}
    </section>

    <section class="eq-dsec">
      <h4 class="eq-dsec-title">Su equipo <span class="eq-muted eq-no-export">· clic en un OP para ver su ficha</span></h4>
      <!-- 4 columnas (antes 8): campaña y asistencia van bajo el nombre, las 3 hojas en una sola columna -->
      <table class="eq-dtable eq-team-table">
        <thead><tr><th>Operador</th><th class="eq-num">Approve</th><th>Errores por hoja</th><th class="eq-num">Total</th></tr></thead>
        <tbody>${members.map(o => `<tr class="eq-row" onclick="eqOpenOP(${jsArg(o.key)})" title="Ver ficha de ${escapeHtml(o.asesor)}">
          <td>
            <div class="eq-op-name eq-team-name">${escapeHtml(o.asesor)}${eqOpMarks(o)}</div>
            <div class="eq-team-meta"><span class="eq-muted">${escapeHtml(o.perop)}</span>${o.pais ? `<span class="eq-nowrap">${countryFlag(o.pais)}${escapeHtml(o.pais)}</span>` : ''}${attBadge(o.asistencia)}</div>
          </td>
          <td class="eq-num">${eqApproveHTML(o.approvePct)}</td>
          <td>${eqTeamErrCell(o)}</td>
          <td class="eq-num"><strong class="${o.errCount ? '' : 'eq-muted'}">${o.errCount}</strong></td>
        </tr>`).join('')}</tbody>
      </table>
    </section>
  </div>

  <section class="eq-dsec">
    <h4 class="eq-dsec-title">Detalle de errores del equipo <span class="eq-muted">· ${eqPeriodLabel()}</span></h4>
    <div id="eq-errlist-box">${eqErrListHTML(records, true)}</div>
  </section>`;
}

/* ══════════════════════════════
   EVOLUCIÓN DE ERRORES — switch Gráfica / Calendario (en la ficha del OP y en la del equipo)
   El calendario es el mismo de Ventas por Fuera, pero con errores: más errores = más rojo,
   día sin errores = verde. Mes = el del filtro (Mes actual / Mes anterior); con "Todo" se navega con ‹ ›.
══════════════════════════════ */
const EQ_WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
let eqCalSource = '';    // '' = todas las hojas
let eqCalDay = null;     // día elegido (su detalle sale debajo del calendario)
let eqCalNav = 0;        // mes que se ve con el periodo "Todo" (0 = actual, -1 = anterior…)

function eqCalResetState() { eqCalSource = ''; eqCalDay = null; }

/* Todos los errores de la ficha abierta (sin filtrar por periodo) */
function eqDrawerAllRecords() {
  const top = eqDrawerStack[eqDrawerStack.length - 1];
  if (!top) return [];
  if (top.type === 'op') { const o = eqFindOp(top.id); return o ? o.errors : []; }
  const t = eqFindTL(top.id);
  return t ? t.ops.flatMap(o => o.errors) : [];
}
function eqDrawerIsTeam() { const top = eqDrawerStack[eqDrawerStack.length - 1]; return !!top && top.type === 'tl'; }

function eqEvoSectionHTML(title) {
  return `<section class="eq-dsec eq-evo">
    <div class="eq-dsec-head">
      <h4 class="eq-dsec-title">${title} <span class="eq-muted" id="eq-evo-scope">· ${eqEvoScopeLabel()}</span></h4>
      <div class="eq-seg eq-evo-switch" role="tablist" aria-label="Ver como">
        <button type="button" class="eq-seg-btn ${eqEvoMode === 'chart' ? 'active' : ''}" role="tab" aria-selected="${eqEvoMode === 'chart'}" onclick="eqSetEvoMode('chart')">📊 Gráfica</button>
        <button type="button" class="eq-seg-btn ${eqEvoMode === 'cal' ? 'active' : ''}" role="tab" aria-selected="${eqEvoMode === 'cal'}" onclick="eqSetEvoMode('cal')">📅 Calendario</button>
      </div>
    </div>
    <div id="eq-evo-box"></div>
  </section>`;
}

function eqEvoScopeLabel() {
  if (eqEvoMode === 'chart') return eqChartScopeLabel();
  const d = errMonthStart(eqCalOffset());
  return `por día, ${ERR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function eqSetEvoMode(mode) {
  if (!['chart', 'cal'].includes(mode) || mode === eqEvoMode) return;
  eqEvoMode = mode;
  eqSavePrefs();
  document.querySelectorAll('.eq-evo-switch .eq-seg-btn').forEach((b, i) => {
    const on = (i === 0) === (mode === 'chart');
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  eqRenderEvo();
}

/* Dibuja lo que toque dentro de #eq-evo-box (la gráfica o el calendario) */
function eqRenderEvo() {
  const box = document.getElementById('eq-evo-box');
  if (!box) return;
  if (eqDrawerChart) { eqDrawerChart.destroy(); eqDrawerChart = null; }
  const scope = document.getElementById('eq-evo-scope');
  if (scope) scope.textContent = `· ${eqEvoScopeLabel()}`;
  const records = eqDrawerAllRecords();
  if (eqEvoMode === 'chart') {
    box.innerHTML = '<div class="eq-chart-wrap"><canvas id="eq-err-chart"></canvas></div>';
    eqRenderErrChart(records);
  } else {
    box.innerHTML = eqCalendarBlockHTML(records);
  }
}

/* Mes que muestra el calendario: el del filtro, o el navegado con "Todo" */
function eqCalOffset() {
  const p = ERR_PERIODS[eqPeriod];
  return p && p.offset !== null ? p.offset : eqCalNav;
}

/* Mes más antiguo con errores (límite de la flecha ‹) */
function eqCalMinOffset(records) {
  const now = new Date();
  let min = 0;
  records.forEach(r => {
    if (!r.date) return;
    const off = (r.date.getFullYear() - now.getFullYear()) * 12 + (r.date.getMonth() - now.getMonth());
    if (off < min) min = off;
  });
  return min;
}

function eqCalNavigate(step) {
  const min = eqCalMinOffset(eqDrawerAllRecords());
  eqCalNav = Math.min(0, Math.max(min, eqCalNav + step));
  eqCalDay = null;
  eqRenderEvo();
}
function eqCalSetSource(key) { eqCalSource = ERR_SOURCES.some(s => s.key === key) ? key : ''; eqRenderEvo(); }
function eqCalPickDay(day) {
  eqCalDay = eqCalDay === day ? null : day;   // clic otra vez en el mismo día = cerrar el detalle
  eqRenderEvo();
  if (eqCalDay) document.querySelector('#eq-evo-box .eq-cal-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* Errores de cada día del mes (solo la hoja elegida, si hay una) */
function eqCalData(records, offset) {
  const start = errMonthStart(offset), end = errMonthStart(offset + 1);
  const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const data = Array.from({ length: days + 1 }, () => ({ total: 0, counts: errCountBySource([]), recs: [] }));
  records.forEach(r => {
    if (!r.date || r.date < start || r.date >= end) return;
    if (eqCalSource && r.source !== eqCalSource) return;
    const d = data[r.date.getDate()];
    d.total++;
    d.counts[r.source]++;
    d.recs.push(r);
  });
  // Días que ya pasaron: en el mes en curso, hasta hoy; en los anteriores, todos
  const lastDay = offset === 0 ? new Date().getDate() : days;
  return { offset, start, end, days, data, lastDay };
}

function eqCalDayLabel(cal, day) {
  const s = new Date(cal.start.getFullYear(), cal.start.getMonth(), day)
    .toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* La cuadrícula (mismas clases vf-cal-* de Ventas por Fuera; los colores de error los pone .eq-cal) */
function eqCalGridHTML(cal) {
  const lead = (cal.start.getDay() + 6) % 7;   // casillas vacías antes del día 1 (la semana empieza el lunes)
  const max = Math.max(1, ...cal.data.slice(1).map(d => d.total));
  const cells = Array(lead).fill(null);
  for (let d = 1; d <= cal.days; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);

  const dayCell = (d, col) => {
    if (!d) return '<div class="vf-cal-cell is-empty"></div>';
    const x = cal.data[d];
    const future = d > cal.lastDay;
    const isToday = cal.offset === 0 && d === cal.lastDay;
    const cls = ['vf-cal-cell', future ? 'is-future' : '', isToday ? 'is-today' : '', col >= 5 ? 'is-weekend' : '',
      !future && !x.total ? 'is-clean' : '', eqCalDay === d ? 'is-on' : ''].join(' ');
    const alpha = x.total ? (0.12 + (x.total / max) * 0.5).toFixed(2) : '0';
    const bar = `<span class="vf-cal-bar">${x.total ? ERR_SOURCES.map(s => x.counts[s.key] ? `<i style="flex:${x.counts[s.key]};background:${s.color}"></i>` : '').join('') : ''}</span>`;
    const tip = future ? 'Todavía no llega este día'
      : x.total ? `${eqCalDayLabel(cal, d)}: ${x.total} error${x.total === 1 ? '' : 'es'} — ${ERR_SOURCES.filter(s => x.counts[s.key]).map(s => `${s.label} ${x.counts[s.key]}`).join(' · ')}`
      : `${eqCalDayLabel(cal, d)}: sin errores`;
    const inner = `<span class="vf-cal-n">${d}${isToday ? '<small>hoy</small>' : ''}</span>
      <span class="vf-cal-v">${future ? '' : (x.total ? x.total : '✓')}</span>${future ? '' : bar}`;
    return !future && x.total
      ? `<button type="button" class="${cls}" style="--a:${alpha}" onclick="eqCalPickDay(${d})" title="${escapeHtml(tip)}">${inner}</button>`
      : `<div class="${cls}" style="--a:${alpha}" title="${escapeHtml(tip)}">${inner}</div>`;
  };

  let html = `<div class="vf-cal-head">${EQ_WEEKDAYS.map((w, i) => `<span class="${i >= 5 ? 'is-weekend' : ''}">${w}</span>`).join('')}<span class="vf-cal-weekcol">Semana</span></div>`;
  for (let w = 0; w < cells.length; w += 7) {
    const week = cells.slice(w, w + 7);
    const weekTotal = week.reduce((s, d) => s + (d ? cal.data[d].total : 0), 0);
    const hasPast = week.some(d => d && d <= cal.lastDay);
    html += `<div class="vf-cal-week">${week.map(dayCell).join('')}
      <div class="vf-cal-weektotal ${hasPast ? '' : 'is-future'}"><span>${hasPast ? weekTotal : ''}</span>${hasPast ? `<small>error${weekTotal === 1 ? '' : 'es'}</small>` : ''}</div></div>`;
  }
  return html;
}

function eqCalSummaryHTML(cal) {
  const past = cal.data.slice(1, cal.lastDay + 1);
  const total = past.reduce((s, d) => s + d.total, 0);
  const clean = past.filter(d => !d.total).length;
  const worst = past.reduce((best, d, i) => (d.total > (best ? best.total : 0) ? { day: i + 1, total: d.total } : best), null);
  const avg = cal.lastDay ? total / cal.lastDay : 0;
  return [
    `<div class="vf-cal-stat eq-cal-stat--main"><span>Total del mes${cal.offset === 0 ? ' (hasta hoy)' : ''}</span><strong>${total.toLocaleString('es-PE')}</strong></div>`,
    `<div class="vf-cal-stat"><span>Peor día</span><strong>${worst ? worst.total : '—'}</strong><small>${worst ? escapeHtml(eqCalDayLabel(cal, worst.day)) : 'ningún error 🎉'}</small></div>`,
    `<div class="vf-cal-stat"><span>Promedio por día</span><strong>${avg.toFixed(1)}</strong><small>${cal.lastDay} día${cal.lastDay === 1 ? '' : 's'}${cal.offset === 0 ? ' hasta hoy' : ' del mes'}</small></div>`,
    `<div class="vf-cal-stat eq-cal-stat--clean"><span>Días sin errores</span><strong>${clean}<em>/${cal.lastDay}</em></strong><small>${cal.lastDay - clean} con algún error</small></div>`,
  ].join('');
}

function eqCalendarBlockHTML(records) {
  const offset = eqCalOffset();
  const cal = eqCalData(records, offset);
  if (eqCalDay && (eqCalDay > cal.lastDay || !cal.data[eqCalDay].total)) eqCalDay = null;
  const monthLabel = `${ERR_MONTHS[cal.start.getMonth()]} ${cal.start.getFullYear()}`;
  const nav = ERR_PERIODS[eqPeriod].offset === null
    ? `<div class="eq-cal-nav">
        <button type="button" class="btn btn-ghost btn-sm" onclick="eqCalNavigate(-1)" ${offset <= eqCalMinOffset(records) ? 'disabled' : ''} aria-label="Mes anterior">‹</button>
        <span class="eq-cal-month">${monthLabel}</span>
        <button type="button" class="btn btn-ghost btn-sm" onclick="eqCalNavigate(1)" ${offset >= 0 ? 'disabled' : ''} aria-label="Mes siguiente">›</button>
      </div>`
    : `<div class="eq-cal-nav"><span class="eq-cal-month">${monthLabel}</span></div>`;
  const counts = errCountBySource(records.filter(r => r.date && r.date >= cal.start && r.date < cal.end));
  const chips = [['', 'Todas', 'var(--nav-accent)'], ...ERR_SOURCES.map(s => [s.key, `${s.label} (${counts[s.key] || 0})`, s.color])]
    .map(([k, l, c]) => `<button type="button" class="dash-tab ${eqCalSource === k ? 'on' : ''}" style="--c:${c}" onclick="eqCalSetSource('${k}')">${escapeHtml(l)}</button>`).join('');
  const undated = records.filter(r => !r.date && (!eqCalSource || r.source === eqCalSource)).length;

  let detail = '';
  if (eqCalDay) {
    const x = cal.data[eqCalDay];
    const opByNum = eqDrawerIsTeam() ? new Map(eqOps.filter(o => o.num).map(o => [o.num, o])) : null;
    const nOps = new Set(x.recs.map(r => r.num)).size;
    detail = `<div class="vf-cal-detail eq-cal-detail">
      <div class="vf-cal-detail-head">
        <div>
          <div class="vf-cal-detail-title">${escapeHtml(eqCalDayLabel(cal, eqCalDay))}</div>
          <div class="vf-cal-detail-sub"><strong>${x.total}</strong> error${x.total === 1 ? '' : 'es'}${opByNum ? ` de ${nOps} OP${nOps === 1 ? '' : 's'}` : ''}
            ${ERR_SOURCES.filter(s => x.counts[s.key]).map(s => `${errSourceBadge(s.key)} <strong>${x.counts[s.key]}</strong>`).join(' ')}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" onclick="eqCalPickDay(${eqCalDay})">✕ Cerrar</button>
      </div>
      <div class="eq-errlist">${x.recs.map(r => eqErrRowHTML(r, opByNum)).join('')}</div>
    </div>`;
  }

  return `<div class="eq-cal-top">${nav}<div class="vf-cal-filter eq-cal-filter">${chips}</div></div>
    <div class="vf-cal eq-cal">${eqCalGridHTML(cal)}</div>
    <div class="vf-cal-summary">${eqCalSummaryHTML(cal)}</div>
    ${undated ? `<div class="eq-muted eq-cal-note">ℹ ${undated} error${undated === 1 ? '' : 'es'} sin fecha en la hoja (no aparecen en el calendario).</div>` : ''}
    ${detail}`;
}

/* ── Ampliar la ficha (se recuerda por navegador) ── */
function eqSyncDrawerWidth() {
  document.getElementById('eq-drawer').classList.toggle('eq-drawer--wide', eqDrawerWide);
  const btn = document.getElementById('eq-drawer-wide');
  if (btn) {
    btn.textContent = eqDrawerWide ? '⤡ Reducir' : '⤢ Ampliar';
    btn.title = eqDrawerWide ? 'Volver al tamaño normal' : 'Ver la ficha casi a pantalla completa';
  }
}
function eqToggleDrawerWide() {
  eqDrawerWide = !eqDrawerWide;
  eqSavePrefs();
  eqSyncDrawerWidth();
  if (eqDrawerChart) setTimeout(() => eqDrawerChart && eqDrawerChart.resize(), 280);   // tras la transición de ancho
}

/* ── Gráfica de errores: por día (7 / 30 días) o por semana (todo, últimas 12) — apilada por hoja ── */
function eqChartScopeLabel() {
  return eqPeriod === 'all' ? 'por semana, últimas 12' : `por día, ${eqPeriodLabel()}`;
}

function eqRenderErrChart(records) {
  const canvas = document.getElementById('eq-err-chart');
  if (!canvas) return;
  eqDrawerChart = new Chart(canvas, eqErrChartConfig(records));
}

/* exportMode = imagen: tamaño fijo, sin animación y a escala ×2 (no la de la pantalla de cada uno) */
function eqErrChartConfig(records, exportMode = false) {
  let labels, keyOf;
  if (eqPeriod === 'all') {
    const weeks = 12, thisWeek = eqWeekStart(new Date());
    const starts = Array.from({ length: weeks }, (_, i) => { const d = new Date(thisWeek); d.setDate(d.getDate() - (weeks - 1 - i) * 7); return d; });
    labels = starts.map(d => `${errFmtDate(d)}`);
    keyOf = r => { const i = starts.findIndex(s => s.getTime() === eqWeekStart(r.date).getTime()); return i; };
  } else {
    // Días del mes elegido: el mes actual hasta hoy, el anterior completo
    const { start, end } = errPeriodBounds(eqPeriod);
    const days = end ? Math.round((end - start) / 86400000) : new Date().getDate();
    labels = Array.from({ length: days }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return errFmtDate(d); });
    keyOf = r => Math.round((new Date(r.date).setHours(0, 0, 0, 0) - start.getTime()) / 86400000);
  }
  const datasets = ERR_SOURCES.map(s => ({ label: s.label, data: Array(labels.length).fill(0), backgroundColor: s.color, borderRadius: 3, stack: 'e' }));
  records.forEach(r => {
    if (!r.date) return;
    const i = keyOf(r);
    if (i < 0 || i >= labels.length) return;
    datasets[ERR_SOURCES.findIndex(s => s.key === r.source)].data[i]++;
  });
  return {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: !exportMode, maintainAspectRatio: false, animation: exportMode ? false : { duration: 250 },
      ...(exportMode ? { devicePixelRatio: GC_EXPORT_SCALE } : {}),
      plugins: { legend: { display: true, labels: { ...chartDefaults.font, boxWidth: 10 } } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { ...chartDefaults.font, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
        y: { stacked: true, grid: { color: CHART_GRID }, ticks: { ...chartDefaults.font, precision: 0 }, beginAtZero: true },
      },
    },
  };
}

/* La gráfica como imagen de tamaño fijo (la del panel depende del ancho y del zoom de cada pantalla) */
const EQ_EXPORT_CHART = { w: 944, h: 240 };
function eqErrChartImage(records) {
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-30000px;top:0;width:${EQ_EXPORT_CHART.w}px;height:${EQ_EXPORT_CHART.h}px;`;
  const canvas = document.createElement('canvas');
  canvas.width = EQ_EXPORT_CHART.w;
  canvas.height = EQ_EXPORT_CHART.h;
  canvas.style.cssText = `width:${EQ_EXPORT_CHART.w}px;height:${EQ_EXPORT_CHART.h}px;`;
  holder.appendChild(canvas);
  document.body.appendChild(holder);
  try {
    const chart = new Chart(canvas, eqErrChartConfig(records, true));
    const url = canvas.toDataURL('image/png');
    chart.destroy();
    const img = document.createElement('img');
    img.src = url;
    img.style.cssText = `width:${EQ_EXPORT_CHART.w}px;height:${EQ_EXPORT_CHART.h}px;display:block;`;
    return img;
  } finally {
    holder.remove();
  }
}

/* ══════════════════════════════
   FICHA DE FEEDBACK — copiar resumen / copiar o descargar imagen
══════════════════════════════ */
function eqFeedbackText() {
  const top = eqDrawerStack[eqDrawerStack.length - 1];
  if (!top) return '';
  const lines = [];
  const bySrc = b => ERR_SOURCES.map(s => `${s.label} ${b[s.key] || 0}`).join(' · ');
  if (top.type === 'op') {
    const o = eqFindOp(top.id);
    lines.push(`📋 FICHA DE FEEDBACK — ${o.asesor} (${o.perop})`);
    lines.push(`👤 Team Leader: ${o.tl}${o.pais ? ` · Campaña: ${o.pais}` : ''}${o.horario ? ` · Horario: ${o.horario}` : ''}`);
    lines.push(`🗓 Periodo: ${eqPeriodLabel()} (al ${errFmtDate(new Date(), true)})`);
    lines.push('');
    lines.push(`❌ Errores: ${o.errCount}${o.errPrevCount !== null ? ` (periodo anterior: ${o.errPrevCount})` : ''}`);
    lines.push(`   ${bySrc(o.errBySource)}`);
    const types = errTopTypes(o.errPeriod, 5);
    if (types.length) {
      lines.push('', '🔁 Errores que más se repiten:');
      types.forEach(t => lines.push(`   • ${t.type} (${errSource(t.source).label}) — ${t.count} ${t.count === 1 ? 'vez' : 'veces'}`));
    }
    if (o.alerts.length) { lines.push('', '⚠ Alertas:'); o.alerts.forEach(a => lines.push(`   • ${a.text}`)); }
    if (o.campaigns.length) {
      lines.push('', `📈 Approve (90 días): ${o.approvePct !== null ? o.approvePct.toFixed(1) + '%' : '—'}`);
      lines.push(`   ${o.campaigns.slice(0, 4).map(c => `${c.country} ${c.approvePct !== null ? c.approvePct.toFixed(1) + '%' : '—'}`).join(' · ')}`);
    }
    const last = o.errPeriod.slice(0, 5);
    if (last.length) {
      lines.push('', '🧾 Últimos errores:');
      last.forEach(r => lines.push(`   • ${errFmtDate(r.date)} · ${errSource(r.source).label} · ${r.type}${r.detail ? ` — ${r.detail}` : ''}${r.orderId ? ` (orden ${r.orderId})` : ''}`));
    }
  } else {
    const t = eqFindTL(top.id);
    lines.push(`📋 RESUMEN DE EQUIPO — ${t.tl}`);
    lines.push(`👥 ${t.size} OPs · Ranking de calidad: #${t.rank} de ${eqTLs.length}`);
    lines.push(`🗓 Periodo: ${eqPeriodLabel()} (al ${errFmtDate(new Date(), true)})`);
    lines.push('');
    lines.push(`❌ Errores del equipo: ${t.errCount}${t.errPrevCount !== null ? ` (periodo anterior: ${t.errPrevCount})` : ''} · ${t.errPerOp.toFixed(2)} por OP`);
    lines.push(`   ${bySrc(t.bySource)}`);
    lines.push(`📈 Approve del equipo (90 días): ${t.approvePct !== null ? t.approvePct.toFixed(1) + '%' : '—'}`);
    const types = errTopTypes(t.ops.flatMap(o => o.errPeriod), 5);
    if (types.length) { lines.push('', '🔁 Errores más comunes:'); types.forEach(x => lines.push(`   • ${x.type} (${errSource(x.source).label}) — ${x.count}`)); }
    const worst = [...t.ops].filter(o => o.errCount).sort((a, b) => b.errCount - a.errCount).slice(0, 5);
    if (worst.length) { lines.push('', '🎯 OPs a acompañar:'); worst.forEach(o => lines.push(`   • ${o.asesor} — ${o.errCount} error${o.errCount === 1 ? '' : 'es'}${o.alerts.length ? ' ⚠' : ''}`)); }
  }
  return lines.join('\n');
}

/* AAAA-MM-DD en la hora local (toISOString daría la fecha UTC: de noche en Perú ya sería "mañana") */
function eqLocalDateStamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function eqCopyFeedback() {
  const ok = await gcCopyText(eqFeedbackText());
  gcSetStatus('eq-drawer-status', ok ? GC_MSG.textCopied : 'No se pudo copiar el resumen.', ok ? 'ok' : 'error');
}

/* Imagen de la ficha: encabezado y pie como las demás imágenes de la página + la parte principal de la
   ficha (sin la lista larga de errores), ancho fijo (.eq-export-card) y la gráfica redibujada a tamaño fijo. */
function eqBuildExportNode() {
  const src = document.getElementById('eq-capture');
  const top = eqDrawerStack[eqDrawerStack.length - 1];
  if (!src || !top) throw new Error('Abre una ficha primero.');
  const card = document.createElement('div');
  card.className = 'eq-export-card';
  card.innerHTML = gcExportHead(top.type === 'op' ? '📋 Ficha del OP' : '👥 Resumen del equipo', { sub: escapeHtml(eqPeriodLabel()) });
  const clone = src.cloneNode(true);
  clone.removeAttribute('id');
  clone.classList.add('eq-export');
  const cloneCanvas = clone.querySelector('canvas');
  if (cloneCanvas) cloneCanvas.replaceWith(eqErrChartImage(eqDrawerAllRecords()));
  card.appendChild(clone);
  card.insertAdjacentHTML('beforeend', gcExportFoot(`Errores de ${escapeHtml(eqPeriodLabel())} · Approve de los últimos 90 días (Approve Stats)`));
  return card;
}

function eqExportFeedback(action) {
  const top = eqDrawerStack[eqDrawerStack.length - 1];
  if (!top) return;
  const name = top.type === 'op' ? (eqFindOp(top.id) || {}).asesor : top.id;
  return gcExportImage({
    action, build: eqBuildExportNode,
    filename: gcFileName(top.type === 'op' ? 'ficha' : 'equipo', name || 'equipo'),
    statusId: 'eq-drawer-status', buttonIds: ['eq-copy-img-btn', 'eq-dl-img-btn'],
  });
}

/* ══════════════════════════════
   🆕 ERRORES NUEVOS DE HOY — diálogo con todos (agrupados por Team Leader) + los quitados
   Se abre desde el KPI "Errores nuevos hoy" o desde la campanita (eqShowNewErrors).
══════════════════════════════ */
let eqPendingNewDialog = false;   // la campanita pidió abrirlo mientras la sección todavía cargaba
let eqNewDlgClose = null;

function eqShowNewErrors() {
  if (gdLoaded && eqErr) eqOpenNewErrors();
  else eqPendingNewDialog = true;
}

function eqNewDlgOpenOP(key) {
  if (eqNewDlgClose) eqNewDlgClose(true);
  setTimeout(() => eqOpenOP(key), 0);
}

function eqNewDialogHTML() {
  const seen = eqErr && eqErr.seen;
  if (!seen || !seen.ok) {
    return `<div class="eq-muted eq-empty-line">${seen && seen.missing
      ? 'Todavía no está activo: falta correr el script <strong>16_errores_nuevos_y_bono.sql</strong> en Supabase.'
      : 'No se pudo consultar qué errores son nuevos. Intenta con "Actualizar".'}</div>`;
  }
  const records = eqAllNewToday().sort((a, b) => errNewAt(b) - errNewAt(a));
  const opByNum = new Map(eqOps.filter(o => o.num).map(o => [o.num, o]));
  const me = tlFindMe(eqTLs.map(t => ({ teamLeader: t.tl })));
  const groups = new Map();
  records.forEach(r => {
    const o = opByNum.get(r.num);
    const g = o ? o.tl : 'Fuera de la distribución';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  });
  // Tu equipo primero (si la cuenta es de un Team Leader), después los que más tienen
  const order = [...groups.keys()].sort((a, b) => ((me && b === me.teamLeader) - (me && a === me.teamLeader)) || (groups.get(b).length - groups.get(a).length) || a.localeCompare(b));
  const bySource = errCountBySource(records);
  const bonoShown = new Set();

  const rowHTML = r => {
    const o = opByNum.get(r.num);
    const linkable = r.orderId && /^\d{6,}$/.test(r.orderId) && r.source !== 'verificacion';
    let jump = '';
    if (o && r.source === 'verificacion' && o.bonoUp && !bonoShown.has(o.key)) {
      bonoShown.add(o.key);
      jump = `<div class="bono-jump">💸 El descuento del bono pasó de ${o.bonoBeforePct ? `−${o.bonoBeforePct}%` : '0%'} a <strong>−${o.bono.pct}%</strong></div>`;
    }
    return `<div class="eq-newrow">
      <span class="eq-newrow-time" title="Detectado en la hoja">${errFmtTime(errNewAt(r))}</span>
      <div class="eq-newrow-main">
        ${o ? `<button type="button" class="eq-err-op" onclick="eqNewDlgOpenOP(${jsArg(o.key)})" title="Ver ficha de ${escapeHtml(o.asesor)}">${eqAvatar(o.asesor)}<span class="eq-err-op-name">${escapeHtml(o.asesor)}</span><span class="eq-err-op-perop">${escapeHtml(o.perop)}</span></button>`
            : `<span class="eq-err-op"><span class="eq-err-op-name">${escapeHtml(r.perop || '—')}</span></span>`}
        <div class="eq-err-type">${errSourceBadge(r.source)} ${escapeHtml(r.type)}</div>
        ${eqErrTextHTML(r)}
        ${jump}
      </div>
      <div class="eq-newrow-side">
        <span class="eq-muted" title="Fecha del error en la hoja">${errFmtDate(r.date, true)}</span>
        ${r.orderId ? (linkable
          ? `<button type="button" class="btn btn-ghost btn-sm rec-link-trigger" onclick="recOpenLinkMenu(event,${jsArg(r.orderId)})">#${escapeHtml(r.orderId)} ▾</button>`
          : `<span class="eq-muted">#${escapeHtml(r.orderId)}</span>`) : ''}
      </div>
    </div>`;
  };

  const removed = seen.removed;
  return `
    <div class="eq-newdlg-sum">
      <strong>${records.length}</strong> error${records.length === 1 ? '' : 'es'} nuevo${records.length === 1 ? '' : 's'} hoy
      ${ERR_SOURCES.map(s => `<span class="eq-chip">${errSourceBadge(s.key)} <strong>${bySource[s.key] || 0}</strong></span>`).join('')}
      ${removed.length ? `<span class="eq-muted">· ${removed.length} quitado${removed.length === 1 ? '' : 's'} de las hojas</span>` : ''}
    </div>
    ${records.length ? order.map(g => `
      <section class="eq-newgroup">
        <h4 class="eq-newgroup-head">${g === 'Fuera de la distribución' ? `<span class="eq-muted">${g}</span>` : recTlBadge(g)}
          ${me && g === me.teamLeader ? '<span class="eq-tag">tu equipo</span>' : ''}
          <span class="eq-muted">${groups.get(g).length}</span></h4>
        ${groups.get(g).map(rowHTML).join('')}
      </section>`).join('')
    : '<div class="eq-muted eq-empty-line">✓ Hoy todavía no apareció ningún error nuevo en las hojas.</div>'}
    ${removed.length ? `<section class="eq-newgroup eq-newgroup--removed">
      <h4 class="eq-newgroup-head">🗑 Quitados hoy de las hojas <span class="eq-muted">(los borraron o corrigieron su texto)</span></h4>
      ${removed.map(x => {
        const o = opByNum.get(x.num);
        return `<div class="eq-newrow">
          <span class="eq-newrow-time">${errFmtTime(x.quitado)}</span>
          <div class="eq-newrow-main"><span class="eq-err-op-name">${escapeHtml(o ? o.asesor : (x.num ? `OP ${x.num}` : '—'))}</span>
            <div class="eq-err-type">${errSourceBadge(x.hoja)} ${escapeHtml(x.tipo || '')}</div></div>
          <div class="eq-newrow-side"><span class="eq-muted">${errFmtDate(x.fecha, true)}</span></div>
        </div>`;
      }).join('')}
    </section>` : ''}
    <p class="eq-newdlg-note">"Nuevo" = apareció hoy en la hoja (aunque la fecha del error sea de otro día). La hora es cuando la página lo vio por primera vez.</p>`;
}

async function eqOpenNewErrors() {
  const box = uiEl('div', 'eq-newdlg');
  box.innerHTML = eqNewDialogHTML();
  await uiDialog({
    title: '🆕 Errores nuevos de hoy', body: box, wide: true, confirmText: 'Cerrar', cancelText: null,
    bindClose: c => { eqNewDlgClose = c; },
  });
  eqNewDlgClose = null;
}

/* ══════════════════════════════
   💸 VISTA: DESCUENTO DEL BONO DE CHECK Y APPROVE
   Errores de Verificación del mes actual por OP → tramo de descuento (tramos editables: bonoEditTiers).
══════════════════════════════ */
let eqBonoTl = '';
let eqBonoSearch = '';
let eqBonoOnly = false;   // solo OPs que ya tienen descuento

/* Recalcula el bono de todos los OPs (tras cambiar los tramos) sin volver a leer las hojas */
function eqRecomputeBono() {
  eqOps.forEach(o => {
    const verif = bonoMonthRecords(o.errors);
    o.bono = bonoInfo(verif.length);
    o.bonoBeforePct = bonoInfo(verif.filter(r => !errNewAt(r)).length).pct;
    o.bonoUp = o.bono.pct > o.bonoBeforePct;
  });
  eqBuildTLs();
}

/* pool = OPs que entran en los conteos (los del turno elegido) */
function eqBonoTiersHTML(pool = eqOps) {
  const counts = bonoTiers.map((t, i) => pool.filter(o => o.bono.idx === i).length);
  const none = pool.filter(o => o.bono.idx < 0).length;
  const meta = bonoTiersMeta && bonoTiersMeta.updated_by && bonoTiersMeta.updated_by !== 'Sistema'
    ? `Tramos guardados por ${escapeHtml(bonoTiersMeta.updated_by)} el ${dataFmtDate(bonoTiersMeta.updated_at)}`
    : 'Tramos del cuadro de descuentos';
  return `<div class="bono-tiers">
      <div class="bono-tier bono-tier--0"><span>0 a ${bonoTiers[0].desde - 1} errores</span><strong>Sin descuento</strong><em>${none} OP${none === 1 ? '' : 's'}</em></div>
      ${bonoTiers.map((t, i) => `<div class="bono-tier bono-tier--${bonoLevel(t.pct)}"><span>${bonoTierRange(i)} errores</span><strong>−${t.pct}%</strong><em>${counts[i]} OP${counts[i] === 1 ? '' : 's'}</em></div>`).join('')}
    </div>
    <div class="bono-meta"><span class="eq-muted">${meta}</span>
      ${can('datalinks.edit') ? '<button type="button" class="btn btn-ghost btn-sm" onclick="bonoEditTiers()">✎ Editar tramos</button>' : ''}</div>`;
}

function eqRenderBono() {
  eqEnsureShift();
  const root = document.getElementById('eq-view-bono');
  const verifOk = eqErr && eqErr.status && eqErr.status.verificacion && eqErr.status.verificacion.ok;
  const pool = eqOps.filter(eqInShift);
  const tls = [...new Set(pool.map(o => o.tl).filter(t => t && t !== '—'))].sort();
  if (eqBonoTl && !tls.includes(eqBonoTl)) eqBonoTl = '';
  root.innerHTML = `<div class="panel mb-22">
    <div class="panel-head">
      <span class="panel-title">💸 Descuento del ${BONO_NAME}</span>
      <span class="muted-11">Errores de <strong>Verificación</strong> de ${errPeriodLabel('cur')} (el mes actual, sin importar el periodo elegido arriba)${eqShift ? ` · <strong>turno ${escapeHtml(eqShift)}</strong>` : ''}</span>
    </div>
    <div class="panel-body">
      ${verifOk ? `${eqShiftBarHTML()}
      ${eqBonoTiersHTML(pool)}
      <div class="gd-filters bono-filters">
        <div class="gd-filter-pill ${eqBonoTl ? 'active' : ''}">
          <span class="pill-label">Team Leader</span>
          <select onchange="eqBonoTl=this.value;eqRenderBono()" aria-label="Team Leader"><option value="">Todos</option>${tls.map(t => `<option value="${escapeHtml(t)}" ${t === eqBonoTl ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
        </div>
        <div class="gd-search-wrap ${eqBonoSearch ? 'active' : ''}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" id="eq-bono-search" placeholder="Buscar operador o PEROP1AM…" value="${escapeHtml(eqBonoSearch)}" oninput="eqBonoSearch=this.value;eqRenderBonoRows()" aria-label="Buscar operador"/>
        </div>
        <label class="eq-check"><input type="checkbox" ${eqBonoOnly ? 'checked' : ''} onchange="eqBonoOnly=this.checked;eqRenderBonoRows()"/> Solo con descuento</label>
      </div>
      <div class="tbl-wrap"><table class="eq-dtable bono-table">
        <thead><tr><th>#</th><th>Operador</th><th>Team Leader</th><th>Horario</th><th class="eq-num">Errores de Verificación</th><th>Descuento</th><th>Siguiente tramo</th></tr></thead>
        <tbody id="eq-bono-tbody"></tbody>
      </table></div>`
      : '<div class="eq-muted eq-empty-line">No se pudo leer la hoja de Verificación: el descuento no se puede calcular por ahora.</div>'}
    </div>
  </div>`;
  if (verifOk) eqRenderBonoRows();
}

function eqRenderBonoRows() {
  const tbody = document.getElementById('eq-bono-tbody');
  if (!tbody) return;
  const q = eqBonoSearch.trim().toLowerCase();
  const rows = eqOps
    .filter(o => o.bono.count > 0 && eqInShift(o) && (!eqBonoOnly || o.bono.pct > 0) && (!eqBonoTl || o.tl === eqBonoTl)
      && (!q || `${o.asesor} ${o.perop}`.toLowerCase().includes(q)))
    .sort((a, b) => (b.bono.count - a.bono.count) || a.asesor.localeCompare(b.asesor));
  const top = bonoTiers[bonoTiers.length - 1].desde;
  tbody.innerHTML = rows.map((o, i) => {
    const next = bonoNextText(o.bono);
    const newVerif = o.newToday.filter(r => r.source === 'verificacion').length;
    return `<tr class="eq-row ${o.bono.faltan === 1 ? 'bono-row-near' : ''}" onclick="eqOpenOP(${jsArg(o.key)})" title="Ver ficha de ${escapeHtml(o.asesor)}">
      <td class="dash-rank">${i + 1}</td>
      <td><div class="eq-op-cell">${eqAvatar(o.asesor)}<div><div class="eq-op-name">${escapeHtml(o.asesor)}</div><div class="eq-muted">${escapeHtml(o.perop)}</div></div></div></td>
      <td>${recTlBadge(o.tl)}</td>
      <td class="eq-nowrap">${gdScheduleBadge(o.horario)}</td>
      <td class="eq-num"><strong>${o.bono.count}</strong>${newVerif ? ` <span class="eq-new-pill" title="Errores de Verificación nuevos hoy">🆕 +${newVerif}</span>` : ''}
        <div class="bono-progress" title="${o.bono.count} de ${top} (tramo más alto)">${bonoTiers.map(t => `<i style="left:${Math.min(100, (t.desde / top) * 100)}%"></i>`).join('')}<span class="bono-${bonoLevel(o.bono.pct)}" style="width:${Math.min(100, (o.bono.count / top) * 100)}%"></span></div></td>
      <td>${bonoBadge(o.bono, { withZero: true })}${o.bonoUp ? ' <span class="eq-new-pill" title="Subió de tramo hoy">▲ hoy</span>' : ''}</td>
      <td class="${o.bono.faltan === 1 ? 'bono-near' : 'eq-muted'}">${next ? `${o.bono.faltan === 1 ? '⚠ ' : ''}${next}` : '—'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="td-empty">${eqOps.some(o => o.bono.count && eqInShift(o))
    ? 'Nadie coincide con el filtro'
    : `✓ Nadie${eqShift ? ` del turno ${escapeHtml(eqShift)}` : ''} tiene errores de Verificación en ${errPeriodLabel('cur')}`}</td></tr>`;
}

/* ══════════════════════════════
   TURNOS — filtro compartido por las vistas Bono y Por día (se recuerda por navegador).
   Si nunca se eligió y la cuenta es de un Team Leader, arranca en el turno de su equipo.
══════════════════════════════ */
function eqInShift(o) { return !eqShift || o.shift === eqShift; }

/* Turno del equipo de la cuenta (si es Team Leader): el que más OPs tiene. '' si no aplica */
function eqMyTeamShift() {
  const me = tlFindMe(eqTLs.map(t => ({ teamLeader: t.tl })));
  const team = me && eqFindTL(me.teamLeader);
  if (!team) return '';
  const count = {};
  team.ops.forEach(o => { if (o.shift) count[o.shift] = (count[o.shift] || 0) + 1; });
  return Object.keys(count).sort((a, b) => count[b] - count[a])[0] || '';
}

function eqEnsureShift() { if (eqShift === null) eqShift = eqMyTeamShift(); }

function eqSetShift(key) {
  eqShift = EQ_SHIFTS.some(s => s.key === key) ? key : '';
  eqSavePrefs();
  if (eqView === 'bono') eqRenderBono();
  if (eqView === 'dia') eqRenderDia();
}

/* Botones de turno, con cuántos OPs tiene cada uno */
function eqShiftBarHTML() {
  const mine = eqMyTeamShift();
  const n = key => eqOps.filter(o => !key || o.shift === key).length;
  const btn = (key, text) => `<button type="button" class="eq-seg-btn ${eqShift === key ? 'active' : ''}" role="tab" aria-selected="${eqShift === key}" onclick="eqSetShift('${key}')">${text}<span class="eq-shift-n">${n(key)}</span>${key && key === mine ? '<span class="eq-shift-mine" title="El turno de tu equipo">tu turno</span>' : ''}</button>`;
  return `<div class="eq-shiftbar"><span class="caps-label">Turno</span>
    <div class="eq-seg" role="tablist" aria-label="Turno">${btn('', 'Todos')}${EQ_SHIFTS.map(s => btn(s.key, `${s.icon} ${s.label}`)).join('')}</div></div>`;
}

/* ══════════════════════════════
   📅 VISTA: ERRORES POR DÍA / POR MES — tabla de calor (filas = Team Leaders, o los OPs de un TL elegido)
   Cuenta solo los errores de los OPs que están HOY en la distribución: de ahí salen su TL y su turno.
   Clic en una casilla = esos errores; clic en un TL = sus OPs; clic en un OP = su ficha.
══════════════════════════════ */
let eqDiaOffset = ERR_PERIODS[eqPeriod].offset ?? 0;   // mes de "Por día" (0 = actual, -1 = anterior…)
let eqDiaSource = '';    // '' = las 3 hojas
let eqDiaTl = '';        // '' = filas por Team Leader · un TL = filas por cada OP de su equipo
let eqDiaLast = null;    // lo último dibujado (para abrir el detalle de una casilla)
const EQ_DIA_MAX_MONTHS = 12;
const EQ_WD_SHORT = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];   // por getDay()

/* Mes más antiguo con errores (offset negativo; límite de la flecha ‹ y de las columnas de "Por mes") */
function eqDiaMinOffset() {
  const now = new Date();
  let min = 0;
  eqOps.forEach(o => o.errors.forEach(r => {
    if (!r.date) return;
    const off = (r.date.getFullYear() - now.getFullYear()) * 12 + (r.date.getMonth() - now.getMonth());
    if (off < min) min = off;
  }));
  return Math.max(min, -(EQ_DIA_MAX_MONTHS - 1));
}

/* Columnas de la tabla: los días del mes elegido, o los meses (hasta 12, desde el primero con datos) */
function eqDiaGrid() {
  const now = new Date();
  if (eqDiaMode === 'dia') {
    const start = errMonthStart(eqDiaOffset), end = errMonthStart(eqDiaOffset + 1);
    const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    const elapsed = eqDiaOffset === 0 ? now.getDate() : days;
    const cols = Array.from({ length: days }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), i + 1);
      const long = d.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' });
      return {
        label: String(i + 1), sub: EQ_WD_SHORT[d.getDay()], title: long.charAt(0).toUpperCase() + long.slice(1),
        weekend: d.getDay() === 0 || d.getDay() === 6, today: eqDiaOffset === 0 && i + 1 === now.getDate(), future: i + 1 > elapsed,
      };
    });
    return { cols, start, end, elapsed, unit: 'día', index: r => r.date.getDate() - 1 };
  }
  const from = eqDiaMinOffset();
  const start = errMonthStart(from), end = errMonthStart(1);
  const cols = Array.from({ length: 1 - from }, (_, i) => {
    const d = errMonthStart(from + i);
    return { label: ERR_MONTHS[d.getMonth()].slice(0, 3), sub: String(d.getFullYear()).slice(2), title: `${ERR_MONTHS[d.getMonth()]} ${d.getFullYear()}`, today: from + i === 0 };
  });
  return {
    cols, start, end, elapsed: cols.length, unit: 'mes',
    index: r => (r.date.getFullYear() - start.getFullYear()) * 12 + (r.date.getMonth() - start.getMonth()),
  };
}

function eqDiaMatch(r) { return !eqDiaSource || r.source === eqDiaSource; }

/* Filas + totales por columna, con el turno, la hoja y el TL elegidos */
function eqDiaData() {
  const grid = eqDiaGrid();
  const pool = eqOps.filter(o => eqInShift(o) && (!eqDiaTl || o.tl === eqDiaTl));
  const rows = new Map();
  const colTotals = grid.cols.map(() => ({ total: 0, recs: [] }));
  const bySource = errCountBySource([]);
  pool.forEach(o => {
    const key = eqDiaTl ? o.key : o.tl;
    if (!rows.has(key)) {
      rows.set(key, eqDiaTl
        ? { key, name: o.asesor, sub: o.perop, op: o, ops: 0, cells: grid.cols.map(() => []), total: 0 }
        : { key, name: o.tl === '—' ? 'Sin Team Leader' : o.tl, sub: '', op: null, ops: 0, cells: grid.cols.map(() => []), total: 0 });
    }
    const row = rows.get(key);
    row.ops++;
    o.errors.forEach(r => {
      if (!r.date || r.date < grid.start || r.date >= grid.end || !eqDiaMatch(r)) return;
      const i = grid.index(r);
      if (i < 0 || i >= grid.cols.length) return;
      row.cells[i].push(r);
      row.total++;
      colTotals[i].total++;
      colTotals[i].recs.push(r);
      bySource[r.source]++;
    });
  });
  const list = [...rows.values()].sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
  return { grid, pool, rows: list, colTotals, bySource, total: list.reduce((s, r) => s + r.total, 0) };
}

/* Errores del periodo anterior equivalente (para la tendencia): mismos días del mes anterior, o el mes completo */
function eqDiaPrevCount(pool, offset, elapsedDays) {
  const start = errMonthStart(offset - 1);
  const end = offset === 0 ? new Date(start.getFullYear(), start.getMonth(), Math.min(elapsedDays, new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate()) + 1) : errMonthStart(offset);
  return pool.reduce((s, o) => s + o.errors.filter(r => r.date && r.date >= start && r.date < end && eqDiaMatch(r)).length, 0);
}

function eqDiaSummaryHTML(D) {
  const { grid, colTotals, total, pool } = D;
  const past = colTotals.slice(0, grid.elapsed);
  const worstIdx = past.reduce((best, c, i) => (c.total > (best < 0 ? 0 : past[best].total) ? i : best), -1);
  const clean = past.filter(c => !c.total).length;
  const avg = grid.elapsed ? total / grid.elapsed : 0;
  if (grid.unit === 'día') {
    const prev = eqDiaPrevCount(pool, eqDiaOffset, grid.elapsed);
    return [
      `<div class="vf-cal-stat eq-cal-stat--main"><span>Total del mes${eqDiaOffset === 0 ? ' (hasta hoy)' : ''}</span><strong>${total.toLocaleString('es-PE')}</strong><small>${eqTrendHTML(total, prev)} ${eqDiaOffset === 0 ? 'vs mismos días del mes anterior' : 'vs el mes de antes'}</small></div>`,
      `<div class="vf-cal-stat"><span>Promedio por día</span><strong>${avg.toFixed(1)}</strong><small>${grid.elapsed} día${grid.elapsed === 1 ? '' : 's'}${eqDiaOffset === 0 ? ' hasta hoy' : ' del mes'}</small></div>`,
      `<div class="vf-cal-stat"><span>Peor día</span><strong>${worstIdx >= 0 ? past[worstIdx].total : '—'}</strong><small>${worstIdx >= 0 ? escapeHtml(grid.cols[worstIdx].title) : 'ningún error 🎉'}</small></div>`,
      `<div class="vf-cal-stat eq-cal-stat--clean"><span>Días sin errores</span><strong>${clean}<em>/${grid.elapsed}</em></strong><small>${grid.elapsed - clean} con algún error</small></div>`,
    ].join('');
  }
  const cur = colTotals[colTotals.length - 1].total;
  const prevSame = eqDiaPrevCount(pool, 0, new Date().getDate());
  return [
    `<div class="vf-cal-stat eq-cal-stat--main"><span>Total · ${grid.cols.length} mes${grid.cols.length === 1 ? '' : 'es'}</span><strong>${total.toLocaleString('es-PE')}</strong><small>desde ${escapeHtml(grid.cols[0].title)}</small></div>`,
    `<div class="vf-cal-stat"><span>Promedio por mes</span><strong>${avg.toFixed(1)}</strong><small>contando el mes en curso</small></div>`,
    `<div class="vf-cal-stat"><span>Peor mes</span><strong>${worstIdx >= 0 ? past[worstIdx].total : '—'}</strong><small>${worstIdx >= 0 ? escapeHtml(grid.cols[worstIdx].title) : 'ningún error 🎉'}</small></div>`,
    `<div class="vf-cal-stat"><span>Este mes (hasta hoy)</span><strong>${cur.toLocaleString('es-PE')}</strong><small>${eqTrendHTML(cur, prevSame)} vs mismos días del mes anterior</small></div>`,
  ].join('');
}

function eqDiaTableHTML(D) {
  const { grid, rows, colTotals, total } = D;
  const maxCell = Math.max(1, ...rows.flatMap(r => r.cells.map(c => c.length)));
  const maxCol = Math.max(1, ...colTotals.map(c => c.total));
  const heat = (n, max) => (n ? (0.14 + (n / max) * 0.62).toFixed(2) : '0');
  const colCls = c => ['eqd-col', c.weekend ? 'is-weekend' : '', c.today ? 'is-today' : '', c.future ? 'is-future' : ''].join(' ');
  const per = r => {
    if (eqDiaTl) return grid.elapsed ? (r.total / grid.elapsed).toFixed(2) : '0';
    return r.ops ? (r.total / r.ops).toFixed(2) : '0';
  };
  const perLabel = eqDiaTl ? `Por ${grid.unit}` : 'Por OP';
  const totalOps = rows.reduce((s, r) => s + r.ops, 0);

  // Total y promedio van junto al nombre (siempre a la vista); los días/meses se deslizan a la derecha
  const bars = `<tr class="eqd-bars" aria-hidden="true"><th class="eqd-sticky"></th><th></th><th></th>${colTotals.map((c, i) => `<th class="${colCls(grid.cols[i])}"><span style="--h:${c.total ? Math.max(8, (c.total / maxCol) * 100) : 0}%"></span></th>`).join('')}</tr>`;
  const head = `<tr><th class="eqd-sticky eqd-name-h">${eqDiaTl ? 'Operador' : 'Team Leader'}</th><th class="eq-num eqd-tot-h">Total</th><th class="eq-num eqd-tot-h eqd-per-h">${perLabel}</th>${grid.cols.map(c => `<th class="${colCls(c)}" title="${escapeHtml(c.title)}"><b>${c.label}</b><small>${c.sub}</small></th>`).join('')}</tr>`;

  const body = rows.map(r => {
    const name = r.op
      ? `<button type="button" class="eqd-name" onclick="eqOpenOP(${jsArg(r.op.key)})" title="Ver ficha de ${escapeHtml(r.name)}">${eqAvatar(r.name)}<span><span class="eqd-name-t">${escapeHtml(r.name)}${eqOpMarks(r.op)}</span><span class="eq-muted">${escapeHtml(r.sub)}</span></span></button>`
      : `<button type="button" class="eqd-name" onclick="eqDiaSetTl(${jsArg(r.key)})" title="Ver los OPs de ${escapeHtml(r.name)}">${eqAvatar(r.name)}<span><span class="eqd-name-t">${escapeHtml(r.name)}</span><span class="eq-muted">${r.ops} OP${r.ops === 1 ? '' : 's'} · ver OPs →</span></span></button>`;
    const cells = r.cells.map((recs, i) => {
      const c = grid.cols[i];
      if (c.future) return `<td class="${colCls(c)} eqd-cell"></td>`;
      if (!recs.length) return `<td class="${colCls(c)} eqd-cell is-zero">·</td>`;
      return `<td class="${colCls(c)} eqd-cell" style="--a:${heat(recs.length, maxCell)}"><button type="button" onclick="eqDiaOpenCell(${jsArg(r.key)},${i})" title="${escapeHtml(`${r.name} · ${c.title}: ${recs.length} error${recs.length === 1 ? '' : 'es'}`)}">${recs.length}</button></td>`;
    }).join('');
    return `<tr><th class="eqd-sticky" scope="row">${name}</th><td class="eq-num eqd-total"><strong class="${r.total ? '' : 'eq-muted'}">${r.total}</strong></td><td class="eq-num eqd-per">${per(r)}</td>${cells}</tr>`;
  }).join('');

  const foot = `<tr class="eqd-foot"><th class="eqd-sticky" scope="row">Total${eqShift ? ` · turno ${escapeHtml(eqShift)}` : ''}</th><td class="eq-num eqd-total"><strong>${total.toLocaleString('es-PE')}</strong></td><td class="eq-num eqd-per">${eqDiaTl ? (grid.elapsed ? (total / grid.elapsed).toFixed(2) : '0') : (totalOps ? (total / totalOps).toFixed(2) : '0')}</td>${colTotals.map((c, i) => {
    const col = grid.cols[i];
    if (col.future) return `<td class="${colCls(col)} eqd-cell"></td>`;
    if (!c.total) return `<td class="${colCls(col)} eqd-cell is-zero is-clean">✓</td>`;
    return `<td class="${colCls(col)} eqd-cell" style="--a:${heat(c.total, maxCol)}"><button type="button" onclick="eqDiaOpenCell(null,${i})" title="${escapeHtml(`${col.title}: ${c.total} error${c.total === 1 ? '' : 'es'}`)}">${c.total}</button></td>`;
  }).join('')}</tr>`;

  return `<table class="eqd-table ${grid.unit === 'mes' ? 'eqd-table--mes' : ''}"><thead>${bars}${head}</thead>
    <tbody>${body || `<tr><td colspan="${grid.cols.length + 3}" class="td-empty">No hay OPs en este turno</td></tr>`}</tbody>
    <tfoot>${foot}</tfoot></table>`;
}

function eqRenderDia() {
  eqEnsureShift();
  const root = document.getElementById('eq-view-dia');
  if (!root) return;
  if (!eqErr || eqErr.error) {
    root.innerHTML = '<div class="panel mb-22"><div class="panel-body"><div class="eq-muted eq-empty-line">Las hojas de errores no están disponibles por ahora. Intenta con "Actualizar".</div></div></div>';
    return;
  }
  const tls = [...new Set(eqOps.filter(eqInShift).map(o => o.tl).filter(t => t && t !== '—'))].sort();
  if (eqDiaTl && !tls.includes(eqDiaTl)) eqDiaTl = '';
  const minOff = eqDiaMinOffset();
  eqDiaOffset = Math.min(0, Math.max(minOff, eqDiaOffset));
  const D = eqDiaData();
  eqDiaLast = D;
  const { grid } = D;

  const monthTitle = grid.unit === 'día' ? `${ERR_MONTHS[grid.start.getMonth()]} ${grid.start.getFullYear()}` : `${grid.cols.length} mes${grid.cols.length === 1 ? '' : 'es'}`;
  const scope = [monthTitle, eqShift ? `turno ${eqShift}` : 'todos los turnos', eqDiaTl || null, eqDiaSource ? errSource(eqDiaSource).full : 'las 3 hojas'].filter(Boolean);
  const nav = grid.unit === 'día'
    ? `<div class="eq-cal-nav">
        <button type="button" class="btn btn-ghost btn-sm" onclick="eqDiaNav(-1)" ${eqDiaOffset <= minOff ? 'disabled' : ''} aria-label="Mes anterior">‹</button>
        <span class="eq-cal-month">${escapeHtml(monthTitle)}</span>
        <button type="button" class="btn btn-ghost btn-sm" onclick="eqDiaNav(1)" ${eqDiaOffset >= 0 ? 'disabled' : ''} aria-label="Mes siguiente">›</button>
      </div>`
    : `<span class="eq-muted">Desde ${escapeHtml(grid.cols[0].title)} hasta hoy</span>`;
  const sourceChips = [['', `Todas (${Object.values(D.bySource).reduce((s, n) => s + n, 0)})`, 'var(--nav-accent)'], ...ERR_SOURCES.map(s => [s.key, `${s.label} (${D.bySource[s.key] || 0})`, s.color])]
    .map(([k, l, c]) => `<button type="button" class="dash-tab ${eqDiaSource === k ? 'on' : ''}" style="--c:${c}" onclick="eqDiaSetSource('${k}')">${escapeHtml(l)}</button>`).join('');
  const modeBtn = (m, t) => `<button type="button" class="eq-seg-btn ${eqDiaMode === m ? 'active' : ''}" role="tab" aria-selected="${eqDiaMode === m}" onclick="eqDiaSetMode('${m}')">${t}</button>`;

  root.innerHTML = `<div class="panel mb-22 eqd">
    <div class="panel-head">
      <span class="panel-title">📅 Errores ${eqDiaMode === 'dia' ? 'por día' : 'por mes'}</span>
      <span class="muted-11">${scope.map(escapeHtml).join(' · ')}</span>
    </div>
    <div class="panel-body">
      <div class="eqd-controls">
        <div class="eq-seg" role="tablist" aria-label="Agrupar por">${modeBtn('dia', '📆 Por día')}${modeBtn('mes', '🗓 Por mes')}</div>
        ${nav}
        <div class="gd-filter-pill ${eqDiaTl ? 'active' : ''} ml-auto">
          <span class="pill-label">Team Leader</span>
          <select onchange="eqDiaSetTl(this.value)" aria-label="Team Leader"><option value="">Todos</option>${tls.map(t => `<option value="${escapeHtml(t)}" ${t === eqDiaTl ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" onclick="eqDiaCopy()" title="Copia la tabla para pegarla en Excel o Google Sheets">📋 Copiar tabla</button>
        <span class="eqd-status" id="eqd-status" role="status"></span>
      </div>
      <div class="eqd-controls">
        ${eqShiftBarHTML()}
        <div class="eqd-sources">${sourceChips}</div>
      </div>
      ${eqDiaTl ? `<div class="eqd-crumb"><button type="button" class="btn btn-ghost btn-sm" onclick="eqDiaSetTl('')">← Todos los Team Leaders</button><span>Equipo de <strong>${escapeHtml(eqDiaTl)}</strong>, un OP por fila</span></div>` : ''}
      <div class="vf-cal-summary eqd-summary">${eqDiaSummaryHTML(D)}</div>
      <div class="eqd-wrap">${eqDiaTableHTML(D)}</div>
      <p class="eqd-note">Clic en un número = ver esos errores · ${eqDiaTl ? 'clic en un OP = su ficha' : 'clic en un Team Leader = ver sus OPs'} · más rojo = más errores.
        Solo cuentan los OPs que están hoy en la distribución (de ahí salen su Team Leader y su turno, según el horario).</p>
    </div>
  </div>`;
}

function eqDiaSetMode(m) { if (m === eqDiaMode) return; eqDiaMode = m; eqSavePrefs(); eqRenderDia(); }
function eqDiaNav(step) { eqDiaOffset += step; eqRenderDia(); }
function eqDiaSetSource(k) { eqDiaSource = ERR_SOURCES.some(s => s.key === k) ? k : ''; eqRenderDia(); }
function eqDiaSetTl(tl) { eqDiaTl = tl || ''; eqRenderDia(); }

/* Detalle de una casilla (rowKey null = la fila de totales) */
async function eqDiaOpenCell(rowKey, i) {
  const D = eqDiaLast;
  if (!D || !D.grid.cols[i]) return;
  const row = rowKey === null ? null : D.rows.find(r => r.key === rowKey);
  const recs = (row ? row.cells[i] : D.colTotals[i].recs).slice().sort((a, b) => (b.date || 0) - (a.date || 0) || a.source.localeCompare(b.source));
  if (!recs.length) return;
  const opByNum = new Map(eqOps.filter(o => o.num).map(o => [o.num, o]));
  const counts = errCountBySource(recs);
  const nOps = new Set(recs.map(r => r.num)).size;
  const box = uiEl('div', 'eq-newdlg');
  box.innerHTML = `<div class="eq-newdlg-sum"><strong>${recs.length}</strong> error${recs.length === 1 ? '' : 'es'} de ${nOps} OP${nOps === 1 ? '' : 's'}
      ${ERR_SOURCES.filter(s => counts[s.key]).map(s => `<span class="eq-chip">${errSourceBadge(s.key)} <strong>${counts[s.key]}</strong></span>`).join('')}</div>
    <div class="eq-errlist">${recs.map(r => eqErrRowHTML(r, opByNum)).join('')}</div>`;
  let close = null;
  box.addEventListener('click', e => { if (e.target.closest('button.eq-err-op') && close) close(true); });   // abre la ficha: el diálogo se cierra
  const who = row ? row.name : (eqDiaTl ? `Equipo de ${eqDiaTl}` : (eqShift ? `Turno ${eqShift}` : 'Todos'));
  await uiDialog({ title: `${who} · ${D.grid.cols[i].title}`, body: box, wide: true, confirmText: 'Cerrar', cancelText: null, bindClose: c => { close = c; } });
}

/* La tabla como texto separado por tabulaciones (se pega directo en Excel / Google Sheets) */
async function eqDiaCopy() {
  const D = eqDiaLast;
  if (!D) return;
  const { grid } = D;
  const head = [eqDiaTl ? 'Operador' : 'Team Leader', ...(eqDiaTl ? ['PEROP1AM'] : ['OPs']), ...grid.cols.map(c => grid.unit === 'día' ? c.label : c.title), 'Total'];
  const line = (name, extra, nums, total) => [name, extra, ...nums.map((n, i) => grid.cols[i].future ? '' : n), total].join('\t');
  const lines = [
    `Errores ${grid.unit === 'día' ? 'por día' : 'por mes'} — ${grid.unit === 'día' ? `${ERR_MONTHS[grid.start.getMonth()]} ${grid.start.getFullYear()}` : `desde ${grid.cols[0].title}`} · ${eqShift ? `turno ${eqShift}` : 'todos los turnos'} · ${eqDiaSource ? errSource(eqDiaSource).full : 'las 3 hojas'}`,
    head.join('\t'),
    ...D.rows.map(r => line(r.name, eqDiaTl ? r.sub : r.ops, r.cells.map(c => c.length), r.total)),
    line('TOTAL', D.rows.reduce((s, r) => s + r.ops, 0), D.colTotals.map(c => c.total), D.total),
  ];
  const ok = await gcCopyText(lines.join('\n'));
  gcSetStatus('eqd-status', ok ? '✓ Tabla copiada — pégala en Excel' : 'No se pudo copiar.', ok ? 'ok' : 'error');
}

/* ══════════════════════════════
   EDITAR LOS TRAMOS (dt_ajustes · permiso datalinks.edit) — desde la vista Bono o Actualización de Data
══════════════════════════════ */
async function bonoEditTiers() {
  if (!can('datalinks.edit')) return;
  await bonoFetchTiers(true);
  let rows = bonoTiers.map(t => ({ ...t }));
  const box = uiEl('div', 'bono-editor');
  const render = () => {
    const sorted = [...rows].sort((a, b) => (Number(a.desde) || 0) - (Number(b.desde) || 0));
    rows = sorted;
    box.innerHTML = `<p class="bono-ed-help">Cada tramo empieza en ese número de errores de <strong>Verificación</strong> del mes y llega hasta donde empieza el siguiente. Menos errores que el primer tramo = sin descuento.</p>
      <table class="bono-ed-table">
        <thead><tr><th>Desde</th><th>Hasta</th><th>Descuento</th><th></th></tr></thead>
        <tbody>${rows.map((t, i) => {
          const next = rows[i + 1];
          const hasta = next && Number(next.desde) > 0 ? `${Number(next.desde) - 1} errores` : 'en adelante';
          return `<tr>
            <td><input type="number" min="1" step="1" class="ui-modal-input" data-i="${i}" data-f="desde" value="${escapeHtml(t.desde)}" aria-label="Desde cuántos errores"/></td>
            <td class="eq-muted bono-ed-hasta">${hasta}</td>
            <td class="bono-ed-pct"><input type="number" min="1" max="100" step="1" class="ui-modal-input" data-i="${i}" data-f="pct" value="${escapeHtml(t.pct)}" aria-label="Porcentaje de descuento"/><span>%</span></td>
            <td><button type="button" class="btn btn-ghost btn-sm" data-del="${i}" title="Quitar este tramo" ${rows.length === 1 ? 'disabled' : ''}>✕</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      <button type="button" class="btn btn-ghost btn-sm" data-add="1">+ Agregar tramo</button>`;
  };
  box.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.f) rows[Number(el.dataset.i)][el.dataset.f] = el.value;
  });
  box.addEventListener('change', e => { if (e.target.dataset.f) render(); });   // al salir del campo: reordena y actualiza "Hasta"
  box.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { rows.splice(Number(del.dataset.del), 1); render(); return; }
    if (e.target.closest('[data-add]')) {
      const last = rows[rows.length - 1];
      rows.push({ desde: last ? Number(last.desde) + 5 : 3, pct: last ? Math.min(100, Number(last.pct) + 10) : 10 });
      render();
    }
  });
  render();

  await uiDialog({
    title: `Tramos del descuento · ${BONO_NAME}`, body: box, confirmText: 'Guardar tramos',
    onConfirm: async () => {
      const tiers = rows.map(t => ({ desde: Number(t.desde), pct: Number(t.pct) }));
      if (!tiers.length) return 'Tiene que haber al menos un tramo.';
      if (tiers.some(t => !Number.isInteger(t.desde) || t.desde < 1)) return '"Desde" tiene que ser un número entero de errores (1 o más).';
      if (tiers.some(t => !Number.isInteger(t.pct) || t.pct < 1 || t.pct > 100)) return 'El descuento tiene que ser un número entero entre 1 y 100.';
      const sorted = [...tiers].sort((a, b) => a.desde - b.desde);
      if (sorted.some((t, i) => i && t.desde === sorted[i - 1].desde)) return 'Dos tramos no pueden empezar en el mismo número de errores.';
      try {
        const user = getCurrentUser();
        const res = await fetch(`${SB_URL}/rest/v1/dt_ajustes?on_conflict=clave`, {
          method: 'POST',
          headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify([{ clave: 'bono_verificacion', valor: { tramos: sorted }, updated_by: user ? user[0] : null, updated_at: new Date().toISOString() }]),
        });
        if (res.status === 404) return 'Falta correr el script 16 (16_errores_nuevos_y_bono.sql) en Supabase.';
        if (!res.ok) return `No se pudo guardar (${await acctErrorDetail(res)}).`;
      } catch (err) {
        return 'No se pudo guardar, revisa tu conexión e intenta de nuevo.';
      }
      await bonoFetchTiers(true);
      if (gdLoaded) {
        eqRecomputeBono();
        eqRenderAll();
        if (eqDrawerStack.length) eqRenderDrawer();
      }
      if (typeof dataUpdateLoaded !== 'undefined' && dataUpdateLoaded) renderDataUpdateTable();
      return null;
    },
  });
}
