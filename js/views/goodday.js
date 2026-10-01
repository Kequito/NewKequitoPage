/* Vista EQUIPOS 360 (antes "GoodDay") — la ficha completa de cada OP y de cada equipo:
   distribución (dt_dis) + asistencia en vivo (core/attendance.js) + campañas y approve de Approve Stats
   (dt_ops, BI-04 últimos 90 días) + errores de calidad en vivo (core/errors.js: Gestión / Tipificación / Verificación).

   Vistas: Por Team Leader (tarjetas) · Todos los OPs (tabla con filtros) · Ranking de calidad.
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

const EQ_PREFS_KEY = 'gc_eq_prefs';
let eqView   = 'tl';     // 'tl' | 'ops' | 'rank'
let eqPeriod = 'cur';    // 'cur' (mes actual) | 'prev' (mes anterior) | 'all' — periodo de los errores
let eqEvoMode = 'chart'; // 'chart' | 'cal' — cómo se ve "Evolución de errores" en las fichas
let eqDrawerWide = false; // ficha ampliada (casi pantalla completa)
(() => {
  try {
    const p = JSON.parse(localStorage.getItem(EQ_PREFS_KEY) || '{}');
    if (['tl', 'ops', 'rank'].includes(p.view)) eqView = p.view;
    if (ERR_PERIODS[p.period]) eqPeriod = p.period;
    if (['chart', 'cal'].includes(p.evo)) eqEvoMode = p.evo;
    eqDrawerWide = !!p.wide;
  } catch { /* sin storage: se usan los valores por defecto */ }
})();
function eqSavePrefs() {
  try { localStorage.setItem(EQ_PREFS_KEY, JSON.stringify({ view: eqView, period: eqPeriod, evo: eqEvoMode, wide: eqDrawerWide })); } catch { /* nada */ }
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
    eqOps.push({
      key, num, perop,
      tl: (d.TEAMLEADER || '').trim() || '—',
      asesor: (d.ASESORES || '').trim() || perop,
      pais: (d.PAIS || '').trim(),
      descanso: (d.DESCANSO || '').trim(),
      horario: (d.HORARIO || '').trim(),
      empresa: (d.EMPRESA || '').trim(),
      asistencia: (eqAtt && eqAtt.map && num) ? (eqAtt.map.get(num) || '') : '',
      campaigns, totalOrders: total, approve,
      approvePct: total > 0 ? (approve / total) * 100 : null,
      errors,
      alerts: errComputeAlerts(errors),
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
  eqRenderAlerts();
  document.getElementById('eq-view-tl').hidden = eqView !== 'tl';
  document.getElementById('eq-view-ops').hidden = eqView !== 'ops';
  document.getElementById('eq-view-rank').hidden = eqView !== 'rank';
  if (eqView === 'tl') eqRenderTLCards();
  if (eqView === 'ops') applyGDFilters();
  if (eqView === 'rank') eqRenderRanking();
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

function eqKpi(label, value, sub = '', cls = '') {
  return `<div class="kpi-card eq-kpi ${cls}">
    <div class="kpi-header"><span class="kpi-label">${label}</span></div>
    <div class="kpi-value">${value}</div>
    ${sub ? `<span class="kpi-sub">${sub}</span>` : ''}
  </div>`;
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
  ].join('');
}

/* ── Alertas automáticas (últimos 7 días, sin importar el periodo elegido) ── */
let eqAlertsExpanded = false;
const EQ_ALERTS_PREVIEW = 6;

function eqAllAlerts() {
  const list = [];
  eqOps.forEach(o => o.alerts.forEach(a => list.push({ ...a, op: o })));
  return list.sort((a, b) => (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1));
}

function eqRenderAlerts() {
  const panel = document.getElementById('eq-alerts-panel');
  const alerts = eqAllAlerts();
  panel.hidden = alerts.length === 0;
  if (!alerts.length) return;
  document.getElementById('eq-alerts-count').textContent = `(${alerts.length})`;
  const shown = eqAlertsExpanded ? alerts : alerts.slice(0, EQ_ALERTS_PREVIEW);
  document.getElementById('eq-alerts-list').innerHTML = shown.map(a => `
    <button type="button" class="eq-alert eq-alert--${a.level}" onclick="eqOpenOP(${jsArg(a.op.key)})">
      <span class="eq-alert-dot"></span>
      <span class="eq-alert-body">
        <span class="eq-alert-title">${escapeHtml(a.op.asesor)} <span class="eq-muted">· ${escapeHtml(a.op.tl)}</span></span>
        <span class="eq-alert-text"><strong>${escapeHtml(a.title)}:</strong> ${escapeHtml(a.text)}</span>
      </span>
      <span class="eq-alert-go">Ver ficha →</span>
    </button>`).join('');
  const more = document.getElementById('eq-alerts-more');
  more.hidden = alerts.length <= EQ_ALERTS_PREVIEW;
  more.textContent = eqAlertsExpanded ? 'Ver menos' : `Ver las ${alerts.length} alertas`;
}

function eqToggleAlerts() {
  eqAlertsExpanded = !eqAlertsExpanded;
  eqRenderAlerts();
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
      ${t.alertOps ? `<div class="eq-tl-alert">⚠ ${t.alertOps} OP${t.alertOps === 1 ? '' : 's'} con alerta</div>` : ''}
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
      <td><div class="eq-op-cell">${eqAvatar(o.asesor)}<div><div class="eq-op-name">${escapeHtml(o.asesor)}${o.alerts.length ? ' <span class="eq-alert-flag" title="Tiene alertas de calidad">⚠</span>' : ''}</div><div class="eq-muted">${escapeHtml(o.perop)}</div></div></div></td>
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
  const filtered = eqDrawerErrFilter === 'all' ? records : records.filter(r => r.source === eqDrawerErrFilter);
  const counts = errCountBySource(records);
  const chips = [['all', `Todos (${records.length})`], ...ERR_SOURCES.map(s => [s.key, `${s.label} (${counts[s.key] || 0})`])]
    .map(([k, l]) => `<button type="button" class="eq-fchip ${eqDrawerErrFilter === k ? 'active' : ''}" onclick="eqSetDrawerErrFilter('${k}')">${l}</button>`).join('');
  const shown = filtered.slice(0, eqDrawerErrLimit);
  const rows = shown.map(r => eqErrRowHTML(r, showOp ? opByNum : null)).join('');
  return `<div class="eq-fchips">${chips}</div>
    ${shown.length ? `<div class="eq-errlist">${rows}</div>` : '<div class="eq-muted eq-empty-line">Sin errores en el periodo 🎉</div>'}
    ${filtered.length > shown.length ? `<button type="button" class="btn btn-ghost btn-sm eq-more-btn" onclick="eqShowMoreErrors()">Ver ${Math.min(25, filtered.length - shown.length)} más (${filtered.length - shown.length} restantes)</button>` : ''}`;
}

/* Una fila de error. opByNum (Map num → OP) = mostrar quién lo cometió */
function eqErrRowHTML(r, opByNum = null) {
  const linkable = r.orderId && /^\d{6,}$/.test(r.orderId) && r.source !== 'verificacion';
  return `<div class="eq-err">
    <div class="eq-err-date">${errFmtDate(r.date, true)}</div>
    <div class="eq-err-main">
      ${opByNum ? eqErrOpLine(r, opByNum.get(r.num)) : ''}
      <div class="eq-err-type">${errSourceBadge(r.source)} ${escapeHtml(r.type)}</div>
      ${r.detail ? `<div class="eq-err-detail">${escapeHtml(r.detail)}</div>` : ''}
      ${r.extra ? `<div class="eq-err-extra">${escapeHtml(r.extra)}</div>` : ''}
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
    </section>

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
    </section>
    ${eqSourceLegend(t.bySource)}

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
      <h4 class="eq-dsec-title">Su equipo <span class="eq-muted">· clic en un OP para ver su ficha</span></h4>
      <!-- 4 columnas (antes 8): campaña y asistencia van bajo el nombre, las 3 hojas en una sola columna -->
      <table class="eq-dtable eq-team-table">
        <thead><tr><th>Operador</th><th class="eq-num">Approve</th><th>Errores por hoja</th><th class="eq-num">Total</th></tr></thead>
        <tbody>${members.map(o => `<tr class="eq-row" onclick="eqOpenOP(${jsArg(o.key)})" title="Ver ficha de ${escapeHtml(o.asesor)}">
          <td>
            <div class="eq-op-name eq-team-name">${escapeHtml(o.asesor)}${o.alerts.length ? ' <span class="eq-alert-flag" title="Tiene alertas de calidad">⚠</span>' : ''}</div>
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
  eqDrawerChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 250 },
      plugins: { legend: { display: true, labels: { ...chartDefaults.font, boxWidth: 10 } } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { ...chartDefaults.font, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
        y: { stacked: true, grid: { color: CHART_GRID }, ticks: { ...chartDefaults.font, precision: 0 }, beginAtZero: true },
      },
    },
  });
}

/* ══════════════════════════════
   FICHA DE FEEDBACK — copiar resumen / descargar imagen
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
  const status = document.getElementById('eq-drawer-status');
  try {
    const text = eqFeedbackText();
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    status.textContent = '✓ Resumen copiado — pégalo en WhatsApp';
  } catch (err) {
    console.error('Error copiando el resumen:', err);
    status.textContent = 'No se pudo copiar el resumen.';
  }
  setTimeout(() => { status.textContent = ''; }, 4000);
}

/* Imagen de la ficha: copia de la parte principal (sin la lista larga de errores), ancho fijo
   para que salga igual para todos; la gráfica (canvas) se pasa como imagen a la copia. */
async function eqDownloadFeedback() {
  const status = document.getElementById('eq-drawer-status');
  const src = document.getElementById('eq-capture');
  if (!src) return;
  status.textContent = 'Generando imagen…';
  try {
    const h2c = await repLoadHtml2Canvas();
    const clone = src.cloneNode(true);
    clone.removeAttribute('id');
    clone.classList.add('eq-export');
    const srcCanvas = src.querySelector('canvas');
    const cloneCanvas = clone.querySelector('canvas');
    if (srcCanvas && cloneCanvas) {
      const img = document.createElement('img');
      img.src = srcCanvas.toDataURL('image/png');
      img.style.cssText = 'width:100%;height:100%;display:block';
      cloneCanvas.replaceWith(img);
    }
    clone.querySelectorAll('img[src*="flagcdn.com"]').forEach(img => { img.removeAttribute('srcset'); img.src = img.src.replace(/\/\d+x\d+\//, '/80x60/'); });
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:-30000px;top:0;';
    holder.appendChild(clone);
    document.body.appendChild(holder);
    let canvas;
    try {
      await Promise.all([...clone.querySelectorAll('img')].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; })));
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--card-bg').trim() || '#1c1e21';
      canvas = await h2c(clone, { backgroundColor: bg, scale: 2, useCORS: true, logging: false, windowWidth: 1400, windowHeight: 1200 });
    } finally {
      holder.remove();
    }
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const top = eqDrawerStack[eqDrawerStack.length - 1];
    const name = top.type === 'op' ? (eqFindOp(top.id) || {}).asesor : top.id;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ficha-${String(name || 'equipo').toLowerCase().replace(/[^a-z0-9]+/gi, '-')}-${eqLocalDateStamp()}.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status.textContent = '✓ Imagen descargada';
  } catch (err) {
    console.error('Error generando la imagen de la ficha:', err);
    status.textContent = (err && err.message) || 'No se pudo generar la imagen.';
  }
  setTimeout(() => { status.textContent = ''; }, 4000);
}
