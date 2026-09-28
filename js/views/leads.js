/* Vista Leads por Campaña — OPs conectados y leads disponibles por cola. */

/* ══════════════════════════════
   LEADS POR CAMPAÑA — OPs conectados + leads disponibles por cola, pegado desde el
   panel de colas (mismo mecanismo copy-paste que Reporte). Cualquier Team Leader o
   Supervisor puede actualizar; solo el link de "Data" queda restringido a Supervisor.
   Cooldown de 3 min compartido (basado en el created_at guardado, no en estado local)
   para que no se pisen actualizaciones entre varias personas.
══════════════════════════════ */
let leadsLoaded = false;
let leadsLatest = null;          // última fila guardada en dt_leads_campana (o null)
let leadsApproveByCountry = {};  // país -> approvePct, del snapshot de Reporte más reciente
let leadsCooldownTimer = null;
let leadsCampaignMode = 'normal'; // 'normal' (Aray, Adcombo) | 'postsale' — igual que Stats OPs Today
const LEADS_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutos
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

async function leadsLoadLatest(silent = false) {
  const [row, approveMap] = await Promise.all([
    leadsFetchLatest(),
    leadsFetchApproveByCountry(),
  ]);
  leadsLatest = row;
  leadsApproveByCountry = approveMap;
  leadsRenderLastUpdate(row);
  leadsApplyCooldown(row ? row.created_at : null);

  const hasData = !!(row && row.by_country && row.by_country.length > 0);
  document.getElementById('leads-empty-state').style.display = hasData ? 'none' : 'flex';
  document.getElementById('leads-campaign-switch').style.display = hasData ? 'block' : 'none';
  document.getElementById('leads-content-wrap').style.display = hasData ? 'flex' : 'none';

  if (!silent) notifRefresh(); // tras guardar Leads nuevos, los avisos de la campanita cambian
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
}

/* Redibuja KPIs + tarjetas según el modo activo — sin volver a pedir nada a Supabase */
function leadsRenderCurrentMode() {
  if (!leadsLatest) return;
  const wantPostSale = leadsCampaignMode === 'postsale';
  const countries = wantPostSale ? leadsPostSaleAsCards(leadsLatest.post_sale) : (leadsLatest.by_country || []);
  const global = wantPostSale
    ? { orders: countries.reduce((s, c) => s + c.sumOrders, 0), totalOrders: countries.reduce((s, c) => s + c.sumTotalOrders, 0) }
    : (leadsLatest.global || { orders: 0, totalOrders: 0 });

  leadsRenderKPIs(global, wantPostSale);
  leadsRenderCountryCards(countries);
  leadsRenderAlerts(leadsLatest, leadsCampaignMode);
}

function leadsRenderLastUpdate(row) {
  const box = document.getElementById('leads-lastupd-box');
  if (!row || !row.created_by) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  document.getElementById('leads-lastupd-name').textContent = row.created_by;
  const d = new Date(row.created_at);
  document.getElementById('leads-lastupd-time').textContent =
    `${d.toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'})} · ${d.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}`;
}

function leadsRenderKPIs(global, isPostSale) {
  const wrap = document.getElementById('leads-kpis');
  const scope = isPostSale ? '(Post-Sale)' : '(Campaña Normal)';
  wrap.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">Leads Disponibles ${scope}</span></div>
      <div class="kpi-value" style="color:${global.orders >= LEADS_LOW_ORDERS_THRESHOLD ? 'var(--green)' : 'var(--red)'}">${escapeHtml(global.orders.toLocaleString('es-PE'))}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">Leads Totales ${scope}</span></div>
      <div class="kpi-value">${escapeHtml(global.totalOrders.toLocaleString('es-PE'))}</div>
    </div>`;
}

/* Fila en rojo cuando quedan menos de LEADS_LOW_ORDERS_THRESHOLD leads disponibles */
function leadsOrdersColor(orders) {
  return orders >= LEADS_LOW_ORDERS_THRESHOLD ? 'var(--green)' : 'var(--red)';
}

function leadsRenderCountryCards(countries) {
  const grid = document.getElementById('leads-country-grid');
  if (countries.length === 0) {
    grid.innerHTML = `<div class="gd-state" style="background:var(--card-bg);border-radius:var(--radius);border:1px solid var(--border)"><p>Sin datos para este tipo de campaña</p></div>`;
    return;
  }
  // Todas las tarjetas rellenan hasta el mismo número de filas — así el "Total" de abajo
  // queda alineado entre países aunque a alguno le falte una cola (ej. Colombia sin 5-2).
  const maxQueues = Math.max(...countries.map(c => c.queues.length), 0);

  grid.innerHTML = countries.map((c, i) => {
    const color = REP_COUNTRY_COLORS[c.country] || REP_FALLBACK_COLORS[i % REP_FALLBACK_COLORS.length];
    const approvePct = leadsApproveByCountry[c.country];
    const approveHtml = approvePct != null
      ? `<span class="rep-approve-badge ${repApproveClass(approvePct)}" style="font-size:11px" title="Approve del reporte más reciente">${repFmtPct(approvePct)}</span>`
      : '';
    const rows = c.queues.map(q => `
      <tr style="${q.orders < LEADS_LOW_ORDERS_THRESHOLD ? 'background:rgba(239,68,68,.14)' : ''}">
        <td style="padding:10px 8px;white-space:nowrap">${escapeHtml(q.name)}</td>
        <td style="padding:10px 4px;text-align:center">${escapeHtml(q.ops)}</td>
        <td style="padding:10px 8px;text-align:right;font-weight:800;color:${leadsOrdersColor(q.orders)}">${escapeHtml(q.orders)}</td>
        <td style="padding:10px 8px;text-align:right;color:var(--text-light)">${escapeHtml(q.totalOrders)}</td>
      </tr>`).join('');
    const fillerRows = Array.from({ length: maxQueues - c.queues.length })
      .map(() => `<tr><td style="padding:10px 8px">&nbsp;</td><td></td><td></td><td></td></tr>`)
      .join('');
    return `
    <div class="panel" style="overflow:hidden;border-top:3px solid ${color}">
      <div class="panel-head" style="background:${color}22">
        <span class="panel-title" style="color:${color}">${countryFlag(c.country)}${escapeHtml(c.country)}</span>
        ${approveHtml}
      </div>
      <div style="overflow-x:auto">
        <table style="min-width:290px">
          <thead><tr><th style="padding:10px 8px;white-space:nowrap">Cola</th><th style="text-align:center;padding:10px 4px;white-space:nowrap">OPs</th><th style="text-align:right;padding:10px 8px;white-space:nowrap">Orders</th><th style="text-align:right;padding:10px 8px;white-space:nowrap">Total</th></tr></thead>
          <tbody>${rows}${fillerRows}</tbody>
          <tfoot><tr style="font-weight:800"><td colspan="2" style="padding:10px 8px;white-space:nowrap">Total</td><td style="text-align:right;padding:10px 8px;color:${leadsOrdersColor(c.sumOrders)}">${escapeHtml(c.sumOrders)}</td><td style="text-align:right;padding:10px 8px">${escapeHtml(c.sumTotalOrders)}</td></tr></tfoot>
        </table>
      </div>
    </div>`;
  }).join('');
}

/* ── Alertas: solo del tipo de campaña que se está viendo en ese momento (switch) ──
   "Sin leads disponibles" ahora exige que TODAS las filas de esa campaña estén en rojo
   (< LEADS_LOW_ORDERS_THRESHOLD) — quedar en 1 o 2 sigue siendo, en la práctica, quedarse
   sin nada en segundos, así que cuenta igual que un 0 total. */
function leadsComputeAlerts(row, mode) {
  if (mode === 'postsale') {
    const postSale = row.post_sale || [];
    const noOps = postSale.filter(c => c.ops === 0).map(c => c.country);
    const noLeads = postSale.filter(c => c.orders < LEADS_LOW_ORDERS_THRESHOLD).map(c => c.country);

    const alerts = [];
    if (noOps.length > 0) {
      alerts.push({ level: 'critical', title: 'Sin operadores conectados',
        text: `${noOps.length} campaña${noOps.length > 1 ? 's' : ''} Post-Sale sin ningún operador conectado: ${noOps.join(', ')}.` });
    }
    if (noLeads.length > 0) {
      alerts.push({ level: 'critical', title: 'Sin leads disponibles',
        text: `${noLeads.length} campaña${noLeads.length > 1 ? 's' : ''} Post-Sale sin leads disponibles: ${noLeads.join(', ')}.` });
    }
    return alerts;
  }

  const countries = row.by_country || [];
  const noOps = countries.filter(c => c.queues.reduce((s, q) => s + q.ops, 0) === 0).map(c => c.country);
  // "Sin leads disponibles": TODAS las filas de la campaña quedaron en rojo (no hace falta que sea 0 exacto)
  const noLeads = countries
    .filter(c => c.queues.length > 0 && c.queues.every(q => q.orders < LEADS_LOW_ORDERS_THRESHOLD))
    .map(c => c.country);
  // "Por quedarse sin leads": las primeras 3 colas ya en rojo (mismo criterio que "sin leads
  // disponibles" de arriba, < LEADS_LOW_ORDERS_THRESHOLD, antes exigía 0 exacto), pero la
  // campaña todavía no califica como "sin leads disponibles" completa (si ya calificó, no
  // hace falta repetirla como warning)
  const nearEmpty = countries
    .filter(c => !noLeads.includes(c.country) && c.queues.slice(0, 3).length > 0 && c.queues.slice(0, 3).every(q => q.orders < LEADS_LOW_ORDERS_THRESHOLD))
    .map(c => c.country);

  const alerts = [];
  if (noOps.length > 0) {
    alerts.push({ level: 'critical', title: 'Sin operadores conectados',
      text: `${noOps.length} campaña${noOps.length > 1 ? 's' : ''} sin ningún operador conectado: ${noOps.join(', ')}.` });
  }
  if (noLeads.length > 0) {
    alerts.push({ level: 'critical', title: 'Sin leads disponibles',
      text: `${noLeads.length} campaña${noLeads.length > 1 ? 's' : ''} con todas sus colas sin leads disponibles: ${noLeads.join(', ')}.` });
  }
  if (nearEmpty.length > 0) {
    alerts.push({ level: 'warning', title: 'Por quedarse sin leads',
      text: `${nearEmpty.length} campaña${nearEmpty.length > 1 ? 's' : ''} con las primeras 3 colas ya en rojo — cerca de agotarse por completo: ${nearEmpty.join(', ')}.` });
  }
  return alerts;
}

function leadsRenderAlerts(row, mode) {
  const body = document.getElementById('leads-alerts-body');
  const alerts = leadsComputeAlerts(row, mode);
  if (alerts.length === 0) {
    body.innerHTML = `<div style="text-align:center;color:var(--text-light);font-size:12px;padding:24px 10px">
      <div style="font-size:24px;margin-bottom:8px">✓</div>
      Todo en orden — sin alertas por ahora
    </div>`;
    return;
  }
  body.innerHTML = alerts.map(a => {
    const critical = a.level === 'critical';
    const color = critical ? 'var(--red)' : 'var(--amber)';
    const bg = critical ? 'var(--red-soft)' : 'var(--amber-soft)';
    return `<div style="padding:16px;border-radius:var(--radius);background:${bg};border:1.5px solid ${color};margin-bottom:14px">
      <div style="font-size:15px;font-weight:800;color:${color};margin-bottom:6px;display:flex;align-items:center;gap:6px"><span style="font-size:18px">${critical ? '🔴' : '🟡'}</span> ${escapeHtml(a.title)}</div>
      <div style="font-size:13.5px;color:var(--text-dark);line-height:1.5">${escapeHtml(a.text)}</div>
    </div>`;
  }).join('');
}

function leadsTogglePaste() {
  const body = document.getElementById('leads-paste-body');
  const chevron = document.getElementById('leads-paste-chevron');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  chevron.style.transform = open ? 'rotate(-90deg)' : 'rotate(0deg)';
}

/* Bloqueo compartido de 3 min: se calcula desde el created_at guardado (no desde estado
   local), así aplica igual para cualquier Team Leader o Supervisor que entre a la página. */
function leadsApplyCooldown(lastCreatedAtIso) {
  if (leadsCooldownTimer) { clearInterval(leadsCooldownTimer); leadsCooldownTimer = null; }
  const btn = document.getElementById('leads-update-btn');
  const text = document.getElementById('leads-cooldown-text');
  if (!btn || !text) return;

  const tick = () => {
    const remaining = lastCreatedAtIso
      ? LEADS_COOLDOWN_MS - (Date.now() - new Date(lastCreatedAtIso).getTime())
      : 0;
    if (remaining <= 0) {
      btn.disabled = false;
      text.textContent = '';
      if (leadsCooldownTimer) { clearInterval(leadsCooldownTimer); leadsCooldownTimer = null; }
      return;
    }
    btn.disabled = true;
    const mm = Math.floor(remaining / 60000);
    const ss = Math.floor((remaining % 60000) / 1000).toString().padStart(2, '0');
    text.textContent = `Ya se actualizó hace poco — podrás volver a actualizar en ${mm}:${ss}`;
  };

  tick();
  if (btn.disabled) leadsCooldownTimer = setInterval(tick, 1000);
}

async function leadsSave() {
  if (!can('leads.save')) return;
  const btn = document.getElementById('leads-update-btn');
  const status = document.getElementById('leads-save-status');
  const errBox = document.getElementById('leads-parse-error');
  errBox.style.display = 'none';

  // Revalida el cooldown contra el servidor justo antes de guardar — por si alguien más
  // actualizó mientras esta persona tenía la página abierta.
  const freshLatest = await leadsFetchLatest();
  if (freshLatest && freshLatest.created_at) {
    const remaining = LEADS_COOLDOWN_MS - (Date.now() - new Date(freshLatest.created_at).getTime());
    if (remaining > 0) {
      leadsLatest = freshLatest;
      leadsApplyCooldown(freshLatest.created_at);
      status.style.color = 'var(--amber)';
      status.textContent = 'Alguien más acaba de actualizar — espera el bloqueo antes de intentar de nuevo.';
      return;
    }
  }

  const raw = document.getElementById('leads-raw-input').value;
  const parsed = leadsParsePaste(raw);
  if (parsed.length === 0) {
    errBox.textContent = 'No pude reconocer filas válidas. Verifica que hayas pegado el bloque completo con encabezado (Country, Name, Number of operators, Capacity, Orders...).';
    errBox.style.display = 'flex';
    return;
  }

  const { countries, postSaleList, global } = leadsAggregate(parsed);
  if (countries.length === 0) {
    errBox.textContent = 'No encontré ninguna cola principal reconocible (ej. "Mexico 1-1") en lo que pegaste.';
    errBox.style.display = 'flex';
    return;
  }

  btn.disabled = true;
  status.style.color = 'var(--text-light)';
  status.textContent = 'Guardando...';
  try {
    const user = getCurrentUser();
    await sbInsert('dt_leads_campana', [{
      created_by: user ? user[0] : null,
      by_country: countries,
      post_sale: postSaleList,
      global,
    }]);
    document.getElementById('leads-raw-input').value = '';
    status.style.color = 'var(--green)';
    status.textContent = '✓ Actualizado';
    setTimeout(() => { status.textContent = ''; }, 6000);
    await leadsLoadLatest();
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
    uiAlert('Aún no se ha configurado el link de Data — pide a un Supervisor que lo configure.', { title: 'Sin link de Data' });
  }
  return false;
}

async function leadsEditDataLink() {
  if (!can('datalinks.edit')) return;
  await dataLinkEdit('leads', 'Leads por Campaña');
  leadsRenderDataLinkBtn();
}
