/* Vista Leads por Campaña — OPs conectados y leads disponibles por cola. */

/* ══════════════════════════════
   LEADS POR CAMPAÑA — OPs conectados + leads disponibles por cola, pegado desde el
   panel de colas (mismo mecanismo copy-paste que Reporte). Cualquier Team Leader o
   Supervisor puede actualizar; solo el link de "Data" queda restringido a Supervisor.
   Cooldown de 2 min compartido (basado en el created_at guardado, no en estado local)
   para que no se pisen actualizaciones entre varias personas.
   Reporte (sección 4, "Operational Coverage") guarda en esta MISMA tabla con
   leadsSubmitPaste(), así que pegar en cualquiera de las dos actualiza ambas.
══════════════════════════════ */
let leadsLoaded = false;
let leadsLatest = null;          // última fila guardada en dt_leads_campana (o null)
let leadsPrev = null;            // la fila anterior (para la tendencia de cada campaña)
let leadsApproveByCountry = {};  // país -> approvePct, del snapshot de Reporte más reciente
let leadsCooldownTimer = null;
let leadsCampaignMode = 'normal'; // 'normal' (Aray, Adcombo) | 'postsale' — igual que Stats OPs Today
const LEADS_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutos
const LEADS_LOW_ORDERS_THRESHOLD = 3; // "fila" en rojo cuando quedan menos de 3 leads disponibles

/* "3. Mexico" -> "Mexico" */
function leadsNormalizeCountry(raw) {
  return (raw || '').replace(/^\s*\d+\.\s*/, '').trim();
}

/* Toma el lado izquierdo de un valor tipo "23 | 6" o "0 -> 3" */
function leadsLeftOf(val, sep) {
  if (!val) return 0;
  const part = String(val).split(sep)[0];
  const n = parseInt(part.replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

/* Ops conectados: en "Number of operators" (ej. "23 | 6") el que cuenta es el lado DERECHO */
function leadsRightOf(val, sep) {
  if (!val) return 0;
  const parts = String(val).split(sep);
  const part = parts.length > 1 ? parts[1] : parts[0];
  const n = parseInt(part.replace(/[^\d-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

/* Cola "principal" de una campaña: termina en N-N (ej. "Mexico 1-1", "Chile 5-2") y no
   es una variante (Priority Call, Overflow, Vitaflex, Special, PS-1/2/3/Auto, WM...). */
function leadsIsMainQueue(name) {
  const n = (name || '').trim();
  if (!/\d+-\d+$/.test(n)) return false;
  if (/priority call/i.test(n)) return false;
  if (/overflow/i.test(n)) return false;
  if (/vitaflex/i.test(n)) return false;
  if (/special/i.test(n)) return false;
  if (/\bWM\b/i.test(n)) return false;
  if (/-PS-/i.test(n)) return false;
  return true;
}

/* Cola de Post Sale que sí contamos: la final "-PS-Auto" (agrega el resto del pipeline PS) */
function leadsIsPostSaleAuto(name) {
  return /-PS-Auto\s*$/i.test((name || '').trim());
}

/* Quita tildes y normaliza espacios/mayúsculas — así "País"/"Pais", "Órdenes"/"Ordenes", etc.
   comparan igual sin importar cómo los haya exportado el panel. */
function leadsNormalizeHeaderCell(s) {
  return (s || '').toString().trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/* El panel deja elegir el idioma al exportar — inglés o español — así que se acepta
   cualquiera de los dos nombres de columna. "cantudad" (con typo) es el nombre real que
   usa el panel en español para "Number of operators", no un error nuestro. */
const LEADS_HEADER_ALIASES = {
  country:  ['country', 'pais'],
  name:     ['name', 'nombre'],
  ops:      ['number of operators', 'cantidad de operadores', 'cantudad de operadores'],
  capacity: ['capacity', 'capacidad'],
  orders:   ['orders', 'ordenes'],
};

function leadsParsePaste(raw) {
  const lines = (raw || '').split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const headerCells = lines[0].split('\t').map(leadsNormalizeHeaderCell);
  const idx = {};
  Object.entries(LEADS_HEADER_ALIASES).forEach(([field, aliases]) => {
    idx[field] = headerCells.findIndex(h => aliases.includes(h));
  });
  if (idx.country === -1 || idx.name === -1 || idx.capacity === -1 || idx.orders === -1) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    if (cells.length < 2) continue; // líneas sueltas (ej. el ícono ☰ de arrastre) sin data real

    // El panel a veces no repite en cada fila la primera columna vacía (checkbox/drag-handle)
    // que sí aparece en el encabezado — si a esta fila le falta exactamente esa celda,
    // todo lo demás se corrió un puesto a la izquierda. Se detecta comparando el largo.
    const offset = (headerCells.length - cells.length === 1) ? 1 : 0;
    const get = (colIdx) => cells[colIdx - offset];

    const name = (get(idx.name) || '').trim();
    if (!name) continue;
    rows.push({
      name,
      country: leadsNormalizeCountry(get(idx.country) || ''),
      ops: idx.ops !== -1 ? leadsRightOf(get(idx.ops), '|') : 0,
      orders: leadsLeftOf(get(idx.capacity), '->'),
      totalOrders: leadsLeftOf(get(idx.orders), '|'),
    });
  }
  return rows;
}

/* Orden natural por el sufijo N-N de la cola (1-1, 2-2, ... 5-2) */
function leadsQueueSortKey(name) {
  const m = (name || '').match(/(\d+)-(\d+)\s*$/);
  return m ? Number(m[1]) * 1000 + Number(m[2]) : 9999;
}

function leadsAggregate(rows) {
  const byCountry = {};
  const postSale = {};

  rows.forEach(r => {
    if (leadsIsMainQueue(r.name)) {
      if (!byCountry[r.country]) byCountry[r.country] = { country: r.country, queues: [], sumOrders: 0, sumTotalOrders: 0 };
      byCountry[r.country].queues.push(r);
      byCountry[r.country].sumOrders += r.orders;
      byCountry[r.country].sumTotalOrders += r.totalOrders;
    } else if (leadsIsPostSaleAuto(r.name)) {
      postSale[r.country] = { country: r.country, ops: r.ops, orders: r.orders, totalOrders: r.totalOrders };
    }
  });

  const countries = Object.values(byCountry).sort((a, b) => a.country.localeCompare(b.country));
  countries.forEach(c => c.queues.sort((a, b) => leadsQueueSortKey(a.name) - leadsQueueSortKey(b.name)));
  const postSaleList = Object.values(postSale).sort((a, b) => a.country.localeCompare(b.country));

  const global = {
    orders: countries.reduce((s, c) => s + c.sumOrders, 0),
    totalOrders: countries.reduce((s, c) => s + c.sumTotalOrders, 0),
  };
  const postSaleGlobal = {
    orders: postSaleList.reduce((s, c) => s + c.orders, 0),
    totalOrders: postSaleList.reduce((s, c) => s + c.totalOrders, 0),
  };

  return { countries, postSaleList, global, postSaleGlobal };
}

async function leadsFetchLatest() {
  try {
    const rows = await sbFetch('dt_leads_campana', 'select=*&order=created_at.desc&limit=1');
    return (rows && rows.length > 0) ? rows[0] : null;
  } catch (err) {
    console.error('Error cargando dt_leads_campana:', err);
    return null;
  }
}

async function leadsInitView() {
  leadsLoaded = true;
  document.getElementById('leads-upload-wrap').style.display = 'flex';
  document.getElementById('leads-paste-panel').style.display = can('leads.save') ? 'block' : 'none';
  await leadsFetchDataLink();
  leadsRenderDataLinkBtn();
  await leadsLoadLatest();
}

/* Approve % por país del snapshot de Reporte más reciente (dt_reportes_ventas) — mismo
   snapshot que usa "Reporte" para sus deltas (repFetchPrevSnapshot), así Leads y Approve
   se leen del mismo "reporte actualizado en este momento" sin depender de que alguien
   haya abierto la sección Reporte en esta sesión. */
async function leadsFetchApproveByCountry() {
  try {
    const snap = await repFetchPrevSnapshot();
    const map = {};
    (snap ? (snap.by_country || []) : []).forEach(c => { map[c.country] = c.approvePct; });
    return map;
  } catch (err) {
    console.error('Error cargando Approve de Reporte para Leads por Campaña:', err);
    return {};
  }
}

/* El último pegado y el anterior: con los dos se calcula la tendencia de cada campaña (▼ 85 en 30 min) */
async function leadsFetchLatestTwo() {
  try {
    return await sbFetch('dt_leads_campana', 'select=*&order=created_at.desc&limit=2');
  } catch (err) {
    console.error('Error cargando dt_leads_campana:', err);
    return [];
  }
}

async function leadsLoadLatest(silent = false) {
  const [rows, approveMap] = await Promise.all([
    leadsFetchLatestTwo(),
    leadsFetchApproveByCountry(),
  ]);
  const row = rows[0] || null;
  leadsLatest = row;
  leadsPrev = rows[1] || null;
  leadsApproveByCountry = approveMap;
  leadsApplyCooldown(row ? row.created_at : null);

  const hasData = !!(row && row.by_country && row.by_country.length > 0);
  document.getElementById('leads-empty-state').style.display = hasData ? 'none' : 'flex';
  document.getElementById('leads-campaign-switch').style.display = hasData ? 'block' : 'none';
  document.getElementById('leads-content-wrap').style.display = hasData && leadsView === 'now' ? 'block' : 'none';
  document.getElementById('leads-sort').value = leadsSort;

  if (!silent) notifRefresh(); // tras guardar Leads nuevos, los avisos de la campanita cambian
  if (leadsView === 'hist' && leadsHistDay === 0) leadsHistLoad(true);   // el historial de hoy suma el pegado nuevo
  if (!hasData) return;
  leadsRenderCurrentMode();
}

/* Convierte la lista de Post-Sale (una fila por país) a la misma forma que by_country
   (país -> queues[]), así se puede reusar exactamente el mismo render de tarjetas. */
function leadsPostSaleAsCards(list) {
  return (list || []).map(c => ({
    country: c.country,
    queues: [{ name: `${c.country}-PS-Auto`, ops: c.ops, orders: c.orders, totalOrders: c.totalOrders }],
    sumOrders: c.orders,
    sumTotalOrders: c.totalOrders,
  }));
}

function leadsSetCampaignMode(mode) {
  if (leadsCampaignMode === mode) return;
  leadsCampaignMode = mode;
  document.querySelectorAll('.leads-campaign-btn').forEach(b => {
    const active = b.dataset.mode === mode;
    b.classList.toggle('btn-primary', active);
    b.classList.toggle('btn-ghost', !active);
  });
  leadsRenderCurrentMode();
  leadsHistRender();
}

/* Campañas de una fila guardada según el modo: Normal (by_country) o Post-Sale (convertida a la misma forma) */
function leadsModeCards(row, mode) {
  if (!row) return [];
  return mode === 'postsale' ? leadsPostSaleAsCards(row.post_sale) : (row.by_country || []);
}

/* Redibuja todo según el modo y el orden activos — sin volver a pedir nada a Supabase */
function leadsRenderCurrentMode() {
  if (!leadsLatest) return;
  const model = leadsSortModel(leadsBuildModel());
  leadsRenderFreshness();
  leadsRenderKPIs(model);
  leadsRenderCountryCards(model);
}

/* ══════════════════════════════
   MODELO — estado, cobertura y tendencia de cada campaña
══════════════════════════════ */
const LEADS_ETA_WARN_MIN   = 30;    // "se agota pronto" si a este ritmo se acaba en 30 min o menos
const LEADS_TREND_MAX_MIN  = 180;   // pegados con más de 3 h de diferencia no sirven para medir ritmo
const LEADS_STALE_WARN_MIN = 20;    // la data se ve en ámbar desde los 20 min…
const LEADS_STALE_BAD_MIN  = 40;    // …y en rojo desde los 40 min

/* Problemas de UNA campaña. Sirve igual para Normal y Post-Sale (Post-Sale viene con una sola "cola").
   Mismas reglas que siempre tuvo el cuadro de alertas (y la campanita, vía leadsComputeAlerts). */
function leadsCountryIssues(c) {
  const queues = c.queues || [];
  const low = q => (Number(q.orders) || 0) < LEADS_LOW_ORDERS_THRESHOLD;
  const issues = [];
  if (queues.reduce((s, q) => s + (Number(q.ops) || 0), 0) === 0) {
    issues.push({ level: 'critical', kind: 'noOps', text: 'Sin operadores conectados' });
  }
  // "Sin leads": TODAS las colas en rojo (quedar en 1 o 2 es, en la práctica, quedarse sin nada en segundos)
  if (queues.length > 0 && queues.every(low)) {
    issues.push({ level: 'critical', kind: 'noLeads', text: 'Sin leads disponibles en ninguna cola' });
  } else if (queues.slice(0, 3).length > 0 && queues.slice(0, 3).every(low)) {
    issues.push({ level: 'warning', kind: 'nearEmpty', text: 'Las primeras 3 colas ya están en rojo' });
  }
  return issues;
}

/* Cambio de leads disponibles contra el pegado anterior, y a qué hora se agotarían a ese ritmo */
function leadsTrendFor(country, available) {
  if (!leadsPrev || !leadsLatest) return null;
  const minutes = (new Date(leadsLatest.created_at) - new Date(leadsPrev.created_at)) / 60000;
  if (!(minutes > 0) || minutes > LEADS_TREND_MAX_MIN) return null;
  const prev = leadsModeCards(leadsPrev, leadsCampaignMode).find(p => p.country === country);
  if (!prev) return null;
  const delta = available - (Number(prev.sumOrders) || 0);
  const etaMin = delta < 0 && available > 0 ? available / (-delta / minutes) : null;
  return { delta, minutes: Math.max(1, Math.round(minutes)), etaMin };
}

function leadsKey(country) { return repCountryKey(country).replace(/[^a-z0-9]+/g, '-'); }

function leadsBuildModel() {
  return leadsModeCards(leadsLatest, leadsCampaignMode).map((c, i) => {
    const cov = repCoverageFor(c);   // disponibles, total, OPs conectados (máx. por cola), OPs +/-, cola actual
    const trend = leadsTrendFor(c.country, cov.available);
    const issues = leadsCountryIssues(c);
    const critical = issues.some(x => x.level === 'critical');
    if (!critical && trend && trend.etaMin !== null && trend.etaMin <= LEADS_ETA_WARN_MIN) {
      issues.push({ level: 'warning', kind: 'soon', text: `A este ritmo se agota en unos ${Math.max(1, Math.round(trend.etaMin))} min` });
    }
    return {
      ...c, cov, trend, issues,
      key: leadsKey(c.country),
      color: REP_COUNTRY_COLORS[c.country] || REP_FALLBACK_COLORS[i % REP_FALLBACK_COLORS.length],
      level: critical ? 'critical' : (issues.length ? 'warning' : 'ok'),
    };
  });
}

/* ── Orden (se recuerda por navegador) ── */
const LEADS_SORT_KEY = 'gc_leads_sort';
let leadsSort = (() => {
  try { const v = localStorage.getItem(LEADS_SORT_KEY); return ['urgency', 'leads', 'alpha'].includes(v) ? v : 'urgency'; } catch { return 'urgency'; }
})();

function leadsSetSort(value) {
  leadsSort = ['urgency', 'leads', 'alpha'].includes(value) ? value : 'urgency';
  try { localStorage.setItem(LEADS_SORT_KEY, leadsSort); } catch { /* sin storage: no se recuerda */ }
  leadsRenderCurrentMode();
}

const LEADS_LEVEL_RANK = { critical: 0, warning: 1, ok: 2 };
function leadsSortModel(model) {
  const byName = (a, b) => a.country.localeCompare(b.country);
  const sorters = {
    urgency: (a, b) => (LEADS_LEVEL_RANK[a.level] - LEADS_LEVEL_RANK[b.level]) || (a.cov.available - b.cov.available) || byName(a, b),
    leads:   (a, b) => (b.cov.available - a.cov.available) || byName(a, b),
    alpha:   byName,
  };
  return model.slice().sort(sorters[leadsSort] || sorters.urgency);
}

/* ══════════════════════════════
   PIEZAS VISUALES
══════════════════════════════ */
const LEADS_LEVEL_UI = {
  critical: { icon: '🔴', label: 'En rojo' },
  warning:  { icon: '🟡', label: 'Atención' },
  ok:       { icon: '🟢', label: 'Bien' },
};

/* "3-3" de "Mexico 3-3"; en Post-Sale no hay número de cola */
function leadsQueueShort(name) {
  const m = String(name || '').match(/(\d+-\d+)\s*$/);
  return m ? m[1] : 'PS';
}

function leadsTrendHTML(t) {
  if (!t) return '';
  if (t.delta === 0) return `<span class="leads-trend leads-trend--flat" title="Igual que en el pegado anterior">= en ${t.minutes} min</span>`;
  const up = t.delta > 0;
  return `<span class="leads-trend leads-trend--${up ? 'up' : 'down'}" title="Cambio desde el pegado anterior">${up ? '▲' : '▼'} ${Math.abs(t.delta).toLocaleString('es-PE')} en ${t.minutes} min</span>`;
}

/* OPs ideales = 1 cada REP_LEADS_PER_OP leads disponibles (mismo cálculo que el Reporte) */
function leadsOpsIdealText(cov) {
  const ideal = Math.round(cov.available / REP_LEADS_PER_OP);
  const d = cov.opsDelta;
  const verdict = d > 0 ? `caben ${d} más` : d < 0 ? `sobran ${-d}` : 'justo';
  return { ideal, verdict, cls: d > 0 ? 'leads-ops--more' : d < 0 ? 'leads-ops--less' : '' };
}

function leadsRenderFreshness() {
  const el = document.getElementById('leads-fresh');
  if (!el || !leadsLatest) return;
  const min = (Date.now() - new Date(leadsLatest.created_at).getTime()) / 60000;
  const state = min >= LEADS_STALE_BAD_MIN ? 'bad' : min >= LEADS_STALE_WARN_MIN ? 'warn' : 'ok';
  el.className = `leads-fresh leads-fresh--${state}`;
  const who = leadsLatest.created_by ? ` · por ${leadsLatest.created_by}` : '';
  el.textContent = `${state === 'ok' ? '🟢' : state === 'warn' ? '🟡' : '🔴'} Datos de ${repTimeAgo(leadsLatest.created_at)}${who}${state === 'ok' ? '' : ' — conviene actualizar'}`;
  const d = new Date(leadsLatest.created_at);
  el.title = `Pegada el ${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })} a las ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}${leadsLatest.created_by ? ` por ${leadsLatest.created_by}` : ''}`;
}
// El "hace X min" se mantiene al día solo mientras se mira la sección
setInterval(() => { if (typeof currentPage !== 'undefined' && currentPage === 'leads' && leadsLatest) leadsRenderFreshness(); }, 30 * 1000);

function leadsRenderKPIs(model) {
  const scope = leadsCampaignMode === 'postsale' ? 'Post-Sale' : 'Campaña Normal';
  const sum = f => model.reduce((s, m) => s + f(m), 0);
  const available = sum(m => m.cov.available);
  const total = sum(m => m.cov.totalOrders);
  const ops = sum(m => m.cov.opsOnline);
  const ideal = sum(m => Math.round(m.cov.available / REP_LEADS_PER_OP));
  document.getElementById('leads-kpis').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">Leads disponibles</span></div>
      <div class="kpi-value ${leadsOrdersClass(available)}">${available.toLocaleString('es-PE')}</div>
      <span class="kpi-sub">${scope}</span>
    </div>
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">Leads totales</span></div>
      <div class="kpi-value">${total.toLocaleString('es-PE')}</div>
      <span class="kpi-sub">${scope}</span>
    </div>
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">OPs conectados</span></div>
      <div class="kpi-value">${ops.toLocaleString('es-PE')}</div>
      <span class="kpi-sub">ideal para los leads que hay: ${ideal.toLocaleString('es-PE')}</span>
    </div>
`;
}

function leadsQueuesHTML(m) {
  const queues = [...(m.queues || [])].sort((a, b) => leadsQueueSortKey(a.name) - leadsQueueSortKey(b.name));
  const max = Math.max(1, ...queues.map(q => Number(q.orders) || 0));
  return queues.map(q => {
    const orders = Number(q.orders) || 0;
    const isLow = orders < LEADS_LOW_ORDERS_THRESHOLD;
    const isCurrent = q.name === m.cov.currentQueue;
    return `<div class="leads-q ${isLow ? 'is-low' : ''} ${isCurrent ? 'is-current' : ''}" ${isCurrent ? 'title="Cola actual: la primera que todavía tiene leads"' : ''}>
      <span class="leads-q-name" title="${escapeHtml(q.name)}">${escapeHtml(q.name)}</span>
      <span class="leads-q-ops" title="OPs con esta cola activada">👤 ${escapeHtml(q.ops)}</span>
      <span class="leads-q-bar" aria-hidden="true"><i style="width:${Math.max(orders ? 3 : 0, (orders / max) * 100).toFixed(1)}%"></i></span>
      <span class="leads-q-num ${leadsOrdersClass(orders)}" title="Leads disponibles">${orders.toLocaleString('es-PE')}</span>
      <span class="leads-q-total" title="Leads totales de la cola">/ ${(Number(q.totalOrders) || 0).toLocaleString('es-PE')}</span>
    </div>`;
  }).join('');
}

function leadsRenderCountryCards(model) {
  const grid = document.getElementById('leads-country-grid');
  if (model.length === 0) {
    grid.innerHTML = `<div class="gd-state card-box"><p>Sin datos para este tipo de campaña</p></div>`;
    return;
  }
  grid.innerHTML = model.map(m => {
    const ui = LEADS_LEVEL_UI[m.level];
    const approvePct = leadsApproveByCountry[m.country];
    const approveHtml = approvePct != null
      ? `<span class="rep-approve-badge leads-approve ${repApproveClass(approvePct)}" title="Approve del reporte más reciente">${repFmtPct(approvePct)}</span>`
      : '';
    const ops = leadsOpsIdealText(m.cov);
    return `
    <div class="panel leads-card leads-card--${m.level}" id="leads-card-${m.key}" style="--c:${m.color}">
      <div class="panel-head">
        <span class="panel-title">${countryFlag(m.country)}${escapeHtml(m.country)}</span>
        <span class="leads-card-badges">${approveHtml}${m.level === 'ok' ? '' : `<span class="leads-status leads-status--${m.level}">${ui.icon} ${ui.label}</span>`}</span>
      </div>
      ${m.issues.length ? `<div class="leads-issues">${m.issues.map(i =>
        `<div class="leads-issue leads-issue--${i.level}">${i.level === 'critical' ? '🔴' : '🟡'} ${escapeHtml(i.text)}</div>`).join('')}</div>` : ''}
      <div class="leads-stats">
        <div class="leads-stat">
          <span class="leads-stat-lbl">Disponibles</span>
          <span class="leads-stat-val ${leadsOrdersClass(m.cov.available)}">${m.cov.available.toLocaleString('es-PE')}</span>
          ${leadsTrendHTML(m.trend)}
        </div>
        <div class="leads-stat">
          <span class="leads-stat-lbl">OPs conectados</span>
          <span class="leads-stat-val">${m.cov.opsOnline}</span>
          <span class="leads-ops ${ops.cls}" title="1 OP cada ${REP_LEADS_PER_OP} leads disponibles">ideal ${ops.ideal} · ${ops.verdict}</span>
        </div>
      </div>
      <div class="leads-queues">${leadsQueuesHTML(m)}</div>
    </div>`;
  }).join('');
}

/* Verde / rojo según si quedan menos de LEADS_LOW_ORDERS_THRESHOLD leads disponibles */
function leadsOrdersClass(orders) {
  return orders >= LEADS_LOW_ORDERS_THRESHOLD ? 'txt-ok' : 'txt-low';
}

/* Alertas resumidas de un modo (Normal / Post-Sale) para la campanita de avisos (core/notifications.js).
   Usa las MISMAS reglas que las tarjetas (leadsCountryIssues), así nunca dicen cosas distintas.
   No incluye "se agota en ~X min": eso necesita el pegado anterior y solo se muestra dentro de la sección. */
function leadsComputeAlerts(row, mode) {
  const cards = leadsModeCards(row, mode);
  const ps = mode === 'postsale' ? ' Post-Sale' : '';
  const having = kind => cards.filter(c => leadsCountryIssues(c).some(i => i.kind === kind)).map(c => c.country);
  const plural = n => `${n} campaña${n > 1 ? 's' : ''}${ps}`;
  const noOps = having('noOps'), noLeads = having('noLeads'), nearEmpty = having('nearEmpty');

  const alerts = [];
  if (noOps.length) {
    alerts.push({ level: 'critical', title: 'Sin operadores conectados',
      text: `${plural(noOps.length)} sin ningún operador conectado: ${noOps.join(', ')}.` });
  }
  if (noLeads.length) {
    alerts.push({ level: 'critical', title: 'Sin leads disponibles',
      text: `${plural(noLeads.length)} con todas sus colas sin leads disponibles: ${noLeads.join(', ')}.` });
  }
  if (nearEmpty.length) {
    alerts.push({ level: 'warning', title: 'Por quedarse sin leads',
      text: `${plural(nearEmpty.length)} con las primeras 3 colas ya en rojo — cerca de agotarse por completo: ${nearEmpty.join(', ')}.` });
  }
  return alerts;
}

/* ══════════════════════════════
   HISTORIAL — cómo cambiaron los leads a lo largo de un día
   No guarda nada nuevo: usa los pegados que ya quedan en dt_leads_campana (cada pegado = un punto).
   Entre dos pegados no se sabe qué pasó: se asume que siguió igual, pero como máximo LEADS_HIST_GAP_MIN;
   si pasó más tiempo sin pegar, ese tramo queda como "sin datos" (corta la línea y no suma al tiempo en rojo).
   Mismas reglas de "en rojo" que las tarjetas (leadsCountryIssues): sin leads / sin OPs.
══════════════════════════════ */
const LEADS_HIST_DAYS = 7;          // hoy + 6 días atrás
const LEADS_HIST_GAP_MIN = 60;      // más de 1 h sin pegar = hueco sin datos
const LEADS_HIST_BANDS = [          // turnos (mismos horarios que Ventas por Fuera), en minutos del día
  { from: 0,    to: 390,  label: 'Madrugada', color: 'rgba(129,140,248,.07)' },
  { from: 390,  to: 870,  label: 'AM',        color: 'rgba(250,204,21,.05)' },
  { from: 870,  to: 1290, label: 'PM',        color: 'rgba(249,115,22,.06)' },
  { from: 1290, to: 1440, label: 'Madrugada', color: 'rgba(129,140,248,.07)' },
];

let leadsView = 'now';           // 'now' (tarjetas) | 'hist'
let leadsHistDay = 0;            // 0 = hoy, 1 = ayer…
let leadsHistMetric = 'leads';   // 'leads' | 'ops'
let leadsHistScale = 'linear';   // 'linear' | 'log' (las campañas chicas no quedan aplastadas contra el 0)
let leadsHistHidden = new Set(); // campañas apagadas en la gráfica
let leadsHistCache = {};         // 'aaaa-mm-dd' → filas del día (los días pasados no cambian; hoy se vuelve a pedir)
let leadsHistChart = null;
let leadsHistBusy = false;

function leadsSetView(view) {
  leadsView = view === 'hist' ? 'hist' : 'now';
  document.querySelectorAll('.leads-view-btn').forEach(b => {
    const on = b.dataset.view === leadsView;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.leads-now-only').forEach(el => { el.hidden = leadsView === 'hist'; });
  document.getElementById('leads-content-wrap').style.display = leadsView === 'now' && leadsLatest ? 'block' : 'none';
  document.getElementById('leads-hist').hidden = leadsView !== 'hist';
  if (leadsView === 'hist') leadsHistLoad();
}

function leadsHistDate(daysBack) { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack); }
function leadsHistKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function leadsHistMin(iso) { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60; }
function leadsHistHHMM(min) { const m = Math.round(min); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }
function leadsHistDur(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')} min` : ''}`;
}
function leadsHistDayLabel(i) {
  if (i === 0) return 'Hoy';
  if (i === 1) return 'Ayer';
  const s = leadsHistDate(i).toLocaleDateString('es-PE', { weekday: 'short', day: 'numeric' }).replace('.', '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function leadsHistSetDay(i) { leadsHistDay = Math.max(0, Math.min(LEADS_HIST_DAYS - 1, Number(i) || 0)); leadsHistLoad(); }
function leadsHistSetMetric(metric) {
  leadsHistMetric = metric === 'ops' ? 'ops' : 'leads';
  document.querySelectorAll('.lh-metric-btn').forEach(b => b.classList.toggle('active', b.dataset.metric === leadsHistMetric));
  leadsHistRender();
}
function leadsHistSetScale(scale) {
  leadsHistScale = scale === 'log' ? 'log' : 'linear';
  document.querySelectorAll('.lh-scale-btn').forEach(b => b.classList.toggle('active', b.dataset.scale === leadsHistScale));
  leadsHistRender();
}
function leadsHistToggle(country) {
  if (leadsHistHidden.has(country)) leadsHistHidden.delete(country); else leadsHistHidden.add(country);
  leadsHistRender();
}
function leadsHistShowAll() { leadsHistHidden.clear(); leadsHistRender(); }
/* Deja solo una campaña (clic en "solo" de su chip); otra vez = todas */
function leadsHistOnly(country) {
  const series = leadsHistSeries(leadsHistCache[leadsHistKey(leadsHistDate(leadsHistDay))] || []);
  const others = series.map(s => s.country).filter(c => c !== country);
  const alreadyOnly = others.every(c => leadsHistHidden.has(c)) && !leadsHistHidden.has(country);
  leadsHistHidden = alreadyOnly ? new Set() : new Set(others);
  leadsHistRender();
}

/* silent = auto-refresh (sin "Cargando…") */
async function leadsHistLoad(silent = false) {
  if (leadsHistBusy) return;
  const day = leadsHistDate(leadsHistDay);
  const key = leadsHistKey(day);
  leadsHistRenderDays();
  if (leadsHistCache[key] && leadsHistDay > 0) { leadsHistRender(); return; }
  leadsHistBusy = true;
  const empty = document.getElementById('lh-empty');
  if (!silent && !leadsHistCache[key]) {
    empty.hidden = false;
    empty.innerHTML = '<p>Cargando el historial…</p>';
    document.getElementById('lh-chart-wrap').hidden = true;
  }
  try {
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    leadsHistCache[key] = await sbFetchAll('dt_leads_campana',
      `select=created_at,created_by,by_country,post_sale&created_at=gte.${encodeURIComponent(day.toISOString())}&created_at=lt.${encodeURIComponent(next.toISOString())}&order=created_at.asc`);
    leadsHistRender();
  } catch (err) {
    console.error('Error cargando el historial de Leads por Campaña:', err);
    if (!leadsHistCache[key]) {
      empty.hidden = false;
      empty.innerHTML = `<p>No se pudo cargar el historial.</p>${uiRetryButton('leadsHistLoad()')}`;
    }
  } finally {
    leadsHistBusy = false;
  }
}

function leadsHistRenderDays() {
  document.getElementById('lh-days').innerHTML = Array.from({ length: LEADS_HIST_DAYS }, (_, i) => {
    const on = i === leadsHistDay;
    return `<button type="button" class="dash-tab ${on ? 'on' : ''}" role="tab" aria-selected="${on}" style="--c:var(--nav-accent)" onclick="leadsHistSetDay(${i})"
      title="${escapeHtml(leadsHistDate(i).toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' }))}">${leadsHistDayLabel(i)}</button>`;
  }).join('');
}

/* Filas del día → una serie por campaña: [{ min, at, by, available, ops, queue, noLeads, noOps }] (del modo activo) */
function leadsHistSeries(rows) {
  const map = new Map();
  rows.forEach(r => {
    const min = leadsHistMin(r.created_at);
    leadsModeCards(r, leadsCampaignMode).forEach(c => {
      const cov = repCoverageFor(c);
      const kinds = leadsCountryIssues(c).map(i => i.kind);
      if (!map.has(c.country)) map.set(c.country, []);
      map.get(c.country).push({
        min, at: r.created_at, by: r.created_by, available: cov.available, ops: cov.opsOnline,
        queue: cov.currentQueue, noLeads: kinds.includes('noLeads'), noOps: kinds.includes('noOps'),
      });
    });
  });
  const countries = [...map.keys()].sort((a, b) => a.localeCompare(b));
  return countries.map((country, i) => ({
    country, points: map.get(country),
    color: REP_COUNTRY_COLORS[country] || REP_FALLBACK_COLORS[i % REP_FALLBACK_COLORS.length],
  }));
}

/* Hasta qué minuto "vale" cada punto: el próximo pegado, pero como máximo LEADS_HIST_GAP_MIN
   (y nunca más allá de ahora / del fin del día) */
function leadsHistEnds(points, limit) {
  return points.map((p, i) => Math.min(i + 1 < points.length ? points[i + 1].min : limit, p.min + LEADS_HIST_GAP_MIN, limit));
}
function leadsHistLimit() {
  const now = new Date();
  return leadsHistDay === 0 ? now.getHours() * 60 + now.getMinutes() : 1440;
}

/* Tiempo en rojo, episodios y momentos clave de una campaña */
function leadsHistAnalyze(s, limit) {
  const pts = s.points;
  const ends = leadsHistEnds(pts, limit);
  const out = { country: s.country, color: s.color, noLeads: { min: 0, times: 0 }, noOps: { min: 0, times: 0 }, events: [] };
  const KINDS = [
    { key: 'noLeads', start: 'se quedó sin leads', back: 'volvió a tener leads', still: 'sigue sin leads', ended: 'terminó el día sin leads' },
    { key: 'noOps', start: 'se quedó sin OPs conectados', back: 'volvió a tener OPs conectados', still: 'sigue sin OPs conectados', ended: 'terminó el día sin OPs conectados' },
  ];
  KINDS.forEach(k => {
    let since = null;
    pts.forEach((p, i) => {
      if (p[k.key]) {
        out[k.key].min += ends[i] - p.min;
        if (since === null) {
          since = p.min;
          out[k.key].times++;
          out.events.push({ min: p.min, tone: 'bad', text: i === 0 ? `ya estaba ${k.start.replace('se quedó ', '')} en el primer pegado del día` : k.start });
        }
      } else if (since !== null) {
        out.events.push({ min: p.min, tone: 'ok', text: `${k.back} · estuvo ${leadsHistDur(p.min - since)} así` });
        since = null;
      }
    });
    if (since !== null) {
      const last = pts[pts.length - 1];
      out.events.push({ min: leadsHistDay === 0 ? Math.max(last.min, limit) : last.min, tone: 'bad', ongoing: true,
        text: `${leadsHistDay === 0 ? k.still : k.ended} · desde las ${leadsHistHHMM(since)}` });
    }
  });
  const byAvail = [...pts].sort((a, b) => a.available - b.available);
  out.minPt = byAvail[0];
  out.maxPt = byAvail[byAvail.length - 1];
  out.lastPt = pts[pts.length - 1];
  return out;
}

/* Huecos: tramos de más de LEADS_HIST_GAP_MIN sin ningún pegado */
function leadsHistGaps(rows, limit) {
  const mins = rows.map(r => leadsHistMin(r.created_at));
  const gaps = [];
  mins.forEach((m, i) => {
    const next = i + 1 < mins.length ? mins[i + 1] : limit;
    if (next - m > LEADS_HIST_GAP_MIN) gaps.push({ from: m + LEADS_HIST_GAP_MIN, to: next });
  });
  return gaps;
}

function leadsHistRender() {
  if (leadsView !== 'hist') return;
  const rows = leadsHistCache[leadsHistKey(leadsHistDate(leadsHistDay))];
  if (!rows) return;
  const series = leadsHistSeries(rows);
  const limit = leadsHistLimit();
  const isPS = leadsCampaignMode === 'postsale';
  document.getElementById('lh-title').textContent = `${leadsHistMetric === 'ops' ? 'OPs conectados' : 'Leads disponibles'} a lo largo del día${isPS ? ' · Post-Sale' : ''}`;

  const empty = document.getElementById('lh-empty');
  const wrap = document.getElementById('lh-chart-wrap');
  if (!series.length) {
    if (leadsHistChart) { leadsHistChart.destroy(); leadsHistChart = null; }
    wrap.hidden = true;
    empty.hidden = false;
    empty.innerHTML = `<p>Nadie pegó datos de ${isPS ? 'Post-Sale ' : ''}este día</p><small>El historial se arma con cada pegado del Panel de colas (aquí o en Reporte).</small>`;
    document.getElementById('lh-info').textContent = '';
    document.getElementById('lh-chips').innerHTML = '';
    document.getElementById('lh-red-body').innerHTML = '<tr><td colspan="6" class="td-empty">Sin datos</td></tr>';
    document.getElementById('lh-events').innerHTML = '<div class="dash-empty">Sin datos este día.</div>';
    document.getElementById('lh-events-count').textContent = '';
    return;
  }
  empty.hidden = true;
  wrap.hidden = false;

  const gaps = leadsHistGaps(rows, limit);
  const first = leadsHistMin(rows[0].created_at), last = leadsHistMin(rows[rows.length - 1].created_at);
  document.getElementById('lh-info').innerHTML = `${rows.length} pegado${rows.length === 1 ? '' : 's'} · de ${leadsHistHHMM(first)} a ${leadsHistHHMM(last)}`
    + (gaps.length ? ` · <span class="lh-gap-note" title="Tramos de más de 1 h sin que nadie pegue datos: ahí no se sabe qué pasó">${gaps.length} hueco${gaps.length === 1 ? '' : 's'} sin datos</span>` : '');

  const analysis = series.map(s => leadsHistAnalyze(s, limit));
  leadsHistRenderChips(series, analysis);
  leadsHistRenderChart(series, gaps, first, Math.max(last, limit === 1440 ? last : limit));
  leadsHistRenderRed(analysis);
  leadsHistRenderEvents(analysis);
}

function leadsHistRenderChips(series, analysis) {
  const visible = series.filter(s => !leadsHistHidden.has(s.country)).length;
  document.getElementById('lh-chips').innerHTML = series.map((s, i) => {
    const off = leadsHistHidden.has(s.country);
    const red = analysis[i].noLeads.min + analysis[i].noOps.min > 0;
    return `<span class="lh-chip ${off ? 'is-off' : ''}" style="--c:${s.color}">
      <button type="button" onclick="leadsHistToggle(${jsArg(s.country)})" title="${off ? 'Mostrar' : 'Ocultar'} ${escapeHtml(s.country)}"><i></i>${countryFlag(s.country)}${escapeHtml(s.country)}${red ? ' <span class="lh-chip-red" title="Estuvo en rojo este día">●</span>' : ''}</button>
      <button type="button" class="lh-chip-only" onclick="leadsHistOnly(${jsArg(s.country)})" title="Ver solo ${escapeHtml(s.country)}">solo</button>
    </span>`;
  }).join('') + (visible < series.length ? '<button type="button" class="btn btn-ghost btn-sm" onclick="leadsHistShowAll()">Mostrar todas</button>' : '');
}

/* Fondo de la gráfica: franjas de turno y huecos sin datos */
const leadsHistBandsPlugin = {
  id: 'lhBands',
  beforeDatasetsDraw(chart, args, opts) {
    const { ctx, chartArea: a, scales: { x } } = chart;
    ctx.save();
    LEADS_HIST_BANDS.forEach(b => {
      const x1 = Math.max(a.left, x.getPixelForValue(b.from)), x2 = Math.min(a.right, x.getPixelForValue(b.to));
      if (x2 <= x1) return;
      ctx.fillStyle = b.color;
      ctx.fillRect(x1, a.top, x2 - x1, a.bottom - a.top);
      if (x2 - x1 > 40) {
        ctx.fillStyle = 'rgba(167,172,177,.55)';
        ctx.font = "600 10px 'Lexend', sans-serif";
        ctx.fillText(b.label, x1 + 6, a.top + 12);
      }
    });
    (opts.gaps || []).forEach(g => {
      const x1 = Math.max(a.left, x.getPixelForValue(g.from)), x2 = Math.min(a.right, x.getPixelForValue(g.to));
      if (x2 <= x1) return;
      const h = a.bottom - a.top;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x1, a.top, x2 - x1, h);
      ctx.clip();
      ctx.fillStyle = 'rgba(0,0,0,.28)';
      ctx.fillRect(x1, a.top, x2 - x1, h);
      ctx.strokeStyle = 'rgba(255,255,255,.07)';   // rayado = sin datos
      ctx.lineWidth = 1;
      for (let px = x1 - h; px < x2; px += 8) { ctx.beginPath(); ctx.moveTo(px, a.bottom); ctx.lineTo(px + h, a.top); ctx.stroke(); }
      ctx.restore();
    });
    ctx.restore();
  },
};

function leadsHistRenderChart(series, gaps, first, last) {
  const metric = leadsHistMetric;
  const log = leadsHistScale === 'log';
  const LOG_ZERO = 0.5;   // en escala logarítmica el 0 no existe: se dibuja abajo del todo y se lee "0"
  const yOf = v => (log ? Math.max(v, LOG_ZERO) : v);
  const xMin = Math.floor(first / 60) * 60;
  const xMax = Math.max(xMin + 180, Math.ceil((last + 1) / 60) * 60);
  const datasets = series.filter(s => !leadsHistHidden.has(s.country)).map(s => {
    const data = [];
    s.points.forEach((p, i) => {
      if (i > 0 && p.min - s.points[i - 1].min > LEADS_HIST_GAP_MIN) data.push({ x: p.min - 1, y: null });   // corta la línea en el hueco
      data.push({ x: p.min, y: yOf(metric === 'ops' ? p.ops : p.available), p });
    });
    return {
      label: s.country, data, borderColor: s.color, backgroundColor: s.color,
      borderWidth: 2, cubicInterpolationMode: 'monotone', spanGaps: false,   // monotone: la curva nunca pasa por debajo/encima de los valores reales
      pointRadius: data.length > 40 ? 0 : 2.5, pointHoverRadius: 5,
      // Los puntos en rojo (sin leads / sin OPs) se marcan con un aro rojo
      pointBorderColor: ctx => (ctx.raw && ctx.raw.p && (ctx.raw.p.noLeads || ctx.raw.p.noOps) ? '#ef4444' : s.color),
      pointBorderWidth: ctx => (ctx.raw && ctx.raw.p && (ctx.raw.p.noLeads || ctx.raw.p.noOps) ? 2.5 : 1),
    };
  });
  if (metric === 'leads') {
    datasets.push({ label: `Límite (${LEADS_LOW_ORDERS_THRESHOLD})`, data: [{ x: xMin, y: LEADS_LOW_ORDERS_THRESHOLD }, { x: xMax, y: LEADS_LOW_ORDERS_THRESHOLD }],
      borderColor: 'rgba(239,68,68,.6)', borderDash: [5, 4], borderWidth: 1.5, pointRadius: 0, _isRef: true });
  }

  if (leadsHistChart) leadsHistChart.destroy();
  leadsHistChart = new Chart(document.getElementById('lh-chart'), {
    type: 'line',
    data: { datasets },
    plugins: [leadsHistBandsPlugin],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'x', intersect: false },
      layout: { padding: { top: 4, right: 8 } },
      plugins: {
        legend: { display: false },
        lhBands: { gaps },
        tooltip: {
          filter: item => !item.dataset._isRef && item.raw && item.raw.p,
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
          callbacks: {
            title: items => {
              const p = items[0] && items[0].raw.p;
              return p ? `${leadsHistHHMM(p.min)}${p.by ? ` · pegado por ${p.by}` : ''}` : '';
            },
            label: ctx => {
              const p = ctx.raw.p;
              const red = [p.noLeads ? 'sin leads' : '', p.noOps ? 'sin OPs' : ''].filter(Boolean).join(' y ');
              return ` ${ctx.dataset.label}: ${p.available.toLocaleString('es-PE')} leads · ${p.ops} OPs · ${p.queue ? `cola ${leadsQueueShort(p.queue)}` : 'sin cola'}${red ? ` · 🔴 ${red}` : ''}`;
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear', min: xMin, max: xMax, grid: { color: CHART_GRID },
          ticks: { ...chartDefaults.font, stepSize: 60, maxRotation: 0, autoSkip: true, maxTicksLimit: 13, callback: v => leadsHistHHMM(v) },
        },
        y: log
          ? {
            type: 'logarithmic', min: LOG_ZERO, grid: { color: CHART_GRID },
            ticks: { ...chartDefaults.font, callback: v => (v === LOG_ZERO ? '0' : [1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000].includes(v) ? Number(v).toLocaleString('es-PE') : null) },
            afterBuildTicks: axis => { axis.ticks = [LOG_ZERO, 1, 3, 10, 30, 100, 300, 1000, 3000, 10000, 30000].filter(v => v <= axis.max * 1.01).map(value => ({ value })); },
          }
          : {
            beginAtZero: true, grid: { color: CHART_GRID },
            ticks: { ...chartDefaults.font, precision: 0, callback: v => Number(v).toLocaleString('es-PE') },
          },
      },
    },
  });
}

function leadsHistRenderRed(analysis) {
  const cell = (x, what) => (x.min > 0
    ? `<span class="lh-red">${leadsHistDur(x.min)}</span><div class="dash-op-code">${x.times} ${x.times === 1 ? 'vez' : 'veces'}</div>`
    : `<span class="lh-never" title="Nunca estuvo ${what} en los pegados de este día">nunca</span>`);
  const at = p => `<div class="dash-op-code">${leadsHistHHMM(p.min)}</div>`;
  const sorted = [...analysis].sort((a, b) => ((b.noLeads.min + b.noOps.min) - (a.noLeads.min + a.noOps.min)) || a.country.localeCompare(b.country));
  document.getElementById('lh-red-body').innerHTML = sorted.map(a => `<tr>
    <td class="nowrap"><span class="rep-period-dot" style="background:${a.color}"></span>${countryFlag(a.country)}${escapeHtml(a.country)}</td>
    <td class="nowrap">${cell(a.noLeads, 'sin leads')}</td>
    <td class="nowrap">${cell(a.noOps, 'sin OPs')}</td>
    <td class="num ${leadsOrdersClass(a.minPt.available)}">${a.minPt.available.toLocaleString('es-PE')}${at(a.minPt)}</td>
    <td class="num">${a.maxPt.available.toLocaleString('es-PE')}${at(a.maxPt)}</td>
    <td class="num ${leadsOrdersClass(a.lastPt.available)}">${a.lastPt.available.toLocaleString('es-PE')}${at(a.lastPt)}</td>
  </tr>`).join('');
}

function leadsHistRenderEvents(analysis) {
  const events = analysis.flatMap(a => a.events.map(e => ({ ...e, country: a.country })))
    .sort((a, b) => (b.min - a.min) || a.country.localeCompare(b.country));   // lo más reciente arriba
  document.getElementById('lh-events-count').textContent = events.length ? `${events.length} · lo más reciente arriba` : '';
  document.getElementById('lh-events').innerHTML = events.length
    ? events.map(e => `<div class="lh-ev lh-ev--${e.tone} ${e.ongoing ? 'is-ongoing' : ''}">
        <span class="lh-ev-time">${e.ongoing && leadsHistDay === 0 ? 'ahora' : leadsHistHHMM(e.min)}</span>
        <span class="lh-ev-dot"></span>
        <span class="lh-ev-txt">${countryFlag(e.country)}<strong>${escapeHtml(e.country)}</strong> ${escapeHtml(e.text)}</span>
      </div>`).join('')
    : '<div class="lh-ev-none">✓ Ninguna campaña se quedó sin leads ni sin OPs en los pegados de este día.</div>';
}

/* ══════════════════════════════
   VISTA PREVIA DEL PEGADO — qué se reconoció, antes de guardar
══════════════════════════════ */
function leadsRenderPreview() {
  const el = document.getElementById('leads-preview');
  const raw = document.getElementById('leads-raw-input').value;
  if (!raw.trim()) { el.hidden = true; el.textContent = ''; return; }
  const parsed = leadsParsePaste(raw);
  el.hidden = false;
  if (!parsed.length) {
    el.className = 'leads-preview leads-preview--bad';
    el.textContent = '⚠ Todavía no reconozco el formato. Copia el bloque completo desde el Panel de colas, incluyendo la fila de encabezado (Country, Name, Number of operators, Capacity, Orders…).';
    return;
  }
  const { countries, postSaleList, global } = leadsAggregate(parsed);
  if (!countries.length) {
    el.className = 'leads-preview leads-preview--bad';
    el.textContent = `⚠ Leí ${parsed.length} filas, pero ninguna es una cola principal (ej. "Mexico 1-1"). ¿Copiaste el bloque correcto?`;
    return;
  }
  const queues = countries.reduce((s, c) => s + c.queues.length, 0);
  el.className = 'leads-preview leads-preview--ok';
  el.innerHTML = `✓ <strong>Listo para guardar:</strong> ${countries.length} campaña${countries.length === 1 ? '' : 's'} (${queues} colas) · `
    + `Post-Sale: ${postSaleList.length} país${postSaleList.length === 1 ? '' : 'es'} · ${global.orders.toLocaleString('es-PE')} leads disponibles`
    + `<span class="leads-preview-list">${countries.map(c => escapeHtml(c.country)).join(' · ')}</span>`;
}

/* ══════════════════════════════
   EXPORTAR COMO IMAGEN — resumen de todas las campañas del modo activo
══════════════════════════════ */
function leadsBuildExportCard() {
  const model = leadsSortModel(leadsBuildModel());
  const d = new Date(leadsLatest.created_at);
  const stamp = `${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
  const crit = model.filter(m => m.level === 'critical').length, warn = model.filter(m => m.level === 'warning').length;
  const sum = f => model.reduce((s, m) => s + f(m), 0);
  const card = document.createElement('div');
  card.className = 'leads-export';
  card.innerHTML = `
    ${gcExportHead('📞 Leads por Campaña', { sub: leadsCampaignMode === 'postsale' ? 'Post-Sale' : 'Campaña Normal', stamp: d })}
    <div class="leads-export-sum">
      <span><strong>${sum(m => m.cov.available).toLocaleString('es-PE')}</strong> leads disponibles</span>
      <span><strong>${sum(m => m.cov.opsOnline).toLocaleString('es-PE')}</strong> OPs conectados</span>
      <span>${crit ? `🔴 <strong>${crit}</strong> en rojo` : '🟢 ninguna en rojo'}${warn ? ` · 🟡 <strong>${warn}</strong> con atención` : ''}</span>
    </div>
    <table class="tl-export-table leads-export-table">
      <thead><tr><th>Campaña</th><th>Estado</th><th class="num">Disponibles</th><th>Cambio</th><th class="num">Total</th><th class="num">OPs</th><th>OPs ideales</th><th>Cola actual</th></tr></thead>
      <tbody>${model.map(m => {
        const ops = leadsOpsIdealText(m.cov);
        return `<tr>
          <td class="nowrap fw-700">${countryFlag(m.country)}${escapeHtml(m.country)}</td>
          <td class="nowrap"><span class="leads-status leads-status--${m.level}">${LEADS_LEVEL_UI[m.level].icon} ${LEADS_LEVEL_UI[m.level].label}</span>${m.issues.length ? `<div class="leads-export-issue">${escapeHtml(m.issues.map(i => i.text).join(' · '))}</div>` : ''}</td>
          <td class="num fw-700 ${leadsOrdersClass(m.cov.available)}">${m.cov.available.toLocaleString('es-PE')}</td>
          <td class="nowrap">${leadsTrendHTML(m.trend) || '<span class="txt-light">—</span>'}</td>
          <td class="num">${m.cov.totalOrders.toLocaleString('es-PE')}</td>
          <td class="num">${m.cov.opsOnline}</td>
          <td class="nowrap"><span class="leads-ops ${ops.cls}">${ops.ideal} · ${ops.verdict}</span></td>
          <td class="nowrap">${m.cov.currentQueue ? escapeHtml(leadsQueueShort(m.cov.currentQueue)) : '<span class="txt-low fw-700">sin leads</span>'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
    ${gcExportFoot(`Data pegada por ${escapeHtml(leadsLatest.created_by || '—')} el ${escapeHtml(stamp)} · OPs ideales = 1 OP cada ${REP_LEADS_PER_OP} leads disponibles · En rojo = sin OPs o sin leads en ninguna cola`)}`;
  return card;
}

function leadsExportImage(action) {
  if (!leadsLatest) return;
  return exportCardImage({
    action, build: leadsBuildExportCard,
    filename: `leads-por-campana-${leadsCampaignMode}-${eqLocalDateStamp()}.png`,
    statusId: 'leads-export-status', buttonIds: ['leads-copy-img-btn', 'leads-dl-img-btn'],
  });
}

function leadsTogglePaste() {
  const body = document.getElementById('leads-paste-body');
  const chevron = document.getElementById('leads-paste-chevron');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  chevron.style.transform = open ? 'rotate(-90deg)' : 'rotate(0deg)';
}

/* Bloqueo compartido de 2 min: se calcula desde el created_at guardado (no desde estado
   local), así aplica igual para cualquier Team Leader o Supervisor que entre a la página.
   Bloquea los dos botones que guardan en dt_leads_campana: el de esta sección y el de
   la sección 4 de Reporte. */
const LEADS_COOLDOWN_TARGETS = [
  { btn: 'leads-update-btn', text: 'leads-cooldown-text' },
  { btn: 'rep-src-btn-coverage', text: 'rep-src-cooldown-coverage' },
];

function leadsApplyCooldown(lastCreatedAtIso) {
  if (leadsCooldownTimer) { clearInterval(leadsCooldownTimer); leadsCooldownTimer = null; }

  const tick = () => {
    const remaining = lastCreatedAtIso
      ? LEADS_COOLDOWN_MS - (Date.now() - new Date(lastCreatedAtIso).getTime())
      : 0;
    const locked = remaining > 0;
    const mm = Math.floor(Math.max(0, remaining) / 60000);
    const ss = Math.floor((Math.max(0, remaining) % 60000) / 1000).toString().padStart(2, '0');
    LEADS_COOLDOWN_TARGETS.forEach(t => {
      const btn = document.getElementById(t.btn);
      const text = document.getElementById(t.text);
      if (btn) btn.disabled = locked;
      if (text) text.textContent = locked ? `Ya se actualizó hace poco — podrás volver a actualizar en ${mm}:${ss}` : '';
    });
    if (!locked && leadsCooldownTimer) { clearInterval(leadsCooldownTimer); leadsCooldownTimer = null; }
    return locked;
  };

  if (tick()) leadsCooldownTimer = setInterval(tick, 1000);
}

/* Guarda un bloque pegado del panel de colas en dt_leads_campana. Lo usan esta sección
   y Reporte (sección 4). Devuelve { ok } o { error, cooldown } — la UI la pone cada llamador. */
async function leadsSubmitPaste(raw) {
  if (!can('leads.save')) return { error: 'Tu cuenta no tiene permiso para actualizar los leads.' };

  // Revalida el cooldown contra el servidor justo antes de guardar — por si alguien más
  // actualizó mientras esta persona tenía la página abierta.
  const freshLatest = await leadsFetchLatest();
  if (freshLatest && freshLatest.created_at) {
    const remaining = LEADS_COOLDOWN_MS - (Date.now() - new Date(freshLatest.created_at).getTime());
    if (remaining > 0) {
      leadsLatest = freshLatest;
      leadsApplyCooldown(freshLatest.created_at);
      return { error: 'Alguien más acaba de actualizar — espera el bloqueo antes de intentar de nuevo.', cooldown: true };
    }
  }

  const parsed = leadsParsePaste(raw);
  if (parsed.length === 0) {
    return { error: 'No pude reconocer filas válidas. Verifica que hayas pegado el bloque completo con encabezado (Country, Name, Number of operators, Capacity, Orders...).' };
  }
  const { countries, postSaleList, global } = leadsAggregate(parsed);
  if (countries.length === 0) {
    return { error: 'No encontré ninguna cola principal reconocible (ej. "Mexico 1-1") en lo que pegaste.' };
  }

  const user = getCurrentUser();
  await sbInsert('dt_leads_campana', [{
    created_by: user ? user[0] : null,
    by_country: countries,
    post_sale: postSaleList,
    global,
  }]);
  // Refresca esta sección (y con ello el bloqueo de ambos botones y la campanita)
  await leadsLoadLatest();
  return { ok: true };
}

async function leadsSave() {
  if (!can('leads.save')) return;
  const btn = document.getElementById('leads-update-btn');
  const status = document.getElementById('leads-save-status');
  const errBox = document.getElementById('leads-parse-error');
  errBox.style.display = 'none';

  btn.disabled = true;
  status.style.color = 'var(--text-light)';
  status.textContent = 'Guardando...';
  try {
    const res = await leadsSubmitPaste(document.getElementById('leads-raw-input').value);
    if (res.error) {
      status.textContent = '';
      if (res.cooldown) {
        status.style.color = 'var(--amber)';
        status.textContent = res.error;
      } else {
        errBox.textContent = res.error;
        errBox.style.display = 'flex';
        btn.disabled = false;
      }
      return;
    }
    document.getElementById('leads-raw-input').value = '';
    leadsRenderPreview();
    status.style.color = 'var(--green)';
    status.textContent = '✓ Actualizado';
    setTimeout(() => { status.textContent = ''; }, 6000);
    // Si Reporte ya está abierto, que refleje la cobertura nueva
    if (typeof repLoaded !== 'undefined' && repLoaded) repLoadCurrentReport(true);
  } catch (err) {
    console.error('Error guardando Leads por Campaña:', err);
    status.style.color = 'var(--red)';
    status.textContent = (err && err.message) ? err.message : 'No se pudo guardar, intenta de nuevo.';
    status.title = status.textContent;
    btn.disabled = false;
  }
}

/* Link de "Data" — mismo mecanismo que Recalls/Stats OPs Today (dt_data_links,
   section_key='leads'). Cualquiera puede abrirlo; solo Supervisor lo cambia. */
async function leadsFetchDataLink() {
  try {
    const rows = await sbFetch('dt_data_links', 'select=*&section_key=eq.leads');
    if (rows && rows[0]) dataLinksMap['leads'] = rows[0];
    else delete dataLinksMap['leads'];
  } catch (err) {
    console.error('Error cargando link de Data de Leads por Campaña:', err);
  }
}

function leadsRenderDataLinkBtn() {
  const btn = document.getElementById('leads-data-link-btn');
  const editBtn = document.getElementById('leads-data-edit-btn');
  if (!btn || !editBtn) return;
  const link = dataLinksMap['leads'];
  btn.href = safeUrl(link && link.url);
  editBtn.style.display = can('datalinks.edit') ? 'inline-flex' : 'none';
}

function leadsOpenDataLink(event) {
  const link = dataLinksMap['leads'];
  if (link && link.url) return true;
  event.preventDefault();
  if (can('datalinks.edit')) {
    leadsEditDataLink();
  } else {
    uiAlert('Aún no se ha configurado el link de Data — pide a quien gestiona los links de Data que lo configure.', { title: 'Sin link de Data' });
  }
  return false;
}

async function leadsEditDataLink() {
  if (!can('datalinks.edit')) return;
  await dataLinkEdit('leads', 'Leads por Campaña');
  leadsRenderDataLinkBtn();
}
