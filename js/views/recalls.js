/* Vista Gestión de Recalls — carga de Excel, árbol TL > Operador > Recalls, comparar status. */

/* ══════════════════════════════
   GESTIÓN DE RECALLS — Excel + comparación de operadores
══════════════════════════════ */
const REC_FIELD_MAP = {
  'id in cc':            'idInCc',
  'country':             'country',
  'substatus':           'substatus',
  'cc comment':          'ccComment',
  'last call operator':  'lastCallOperator',
};

let recLoaded          = false;
let recCurrentRows     = [];
let recCurrentFiltered = [];
let recAlertRows       = [];

function recNormalizeHeader(s) { return (s || '').toString().trim().toLowerCase(); }

/* Lee el workbook y extrae solo las 5 columnas que nos interesan, emparejando por nombre de encabezado */
function recParseWorkbook(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (raw.length === 0) return [];

  const keyMap = {};
  Object.keys(raw[0]).forEach(k => { keyMap[recNormalizeHeader(k)] = k; });

  return raw.map(row => {
    const out = {};
    Object.entries(REC_FIELD_MAP).forEach(([normHeader, field]) => {
      const actualKey = keyMap[normHeader];
      out[field] = actualKey !== undefined ? String(row[actualKey] ?? '').trim() : '';
    });
    return out;
  }).filter(r => r.idInCc);
}

/* Índice PEROP1AM -> {teamLeader, asesor, horario}, mismo origen que GoodDay/OPs Performance */
async function recFetchDisIndex() {
  try {
    const rows = await sbFetch('dt_dis', 'select=PEROP1AM,ASESORES,TEAMLEADER,HORARIO');
    const idx = {};
    rows.forEach(r => {
      const p = (r.PEROP1AM || '').trim();
      if (p && !idx[p]) idx[p] = { asesor: r.ASESORES || '', teamLeader: r.TEAMLEADER || '', horario: r.HORARIO || '' };
    });
    return idx;
  } catch (err) {
    console.error('Error cargando dt_dis para Recalls:', err);
    return {};
  }
}

function recEnrich(rows, disIdx) {
  return rows.map(r => {
    const info = disIdx[r.lastCallOperator] || {};
    return {
      idInCc: r.idInCc,
      country: r.country,
      substatus: r.substatus,
      ccComment: r.ccComment,
      lastCallOperator: r.lastCallOperator,
      teamLeader: info.teamLeader || '—',
      asesor: info.asesor || '—',
      horario: info.horario || '—',
    };
  });
}

/* Compara la carga nueva contra el estado anterior (dt_recalls) buscando cambios de operador por Id in CC */
function recDetectChanges(oldRows, newRows) {
  const oldIdx = {};
  oldRows.forEach(r => { if (r.id_in_cc) oldIdx[r.id_in_cc] = r; });
  const alerts = [];
  newRows.forEach(n => {
    const old = oldIdx[n.idInCc];
    if (old && old.last_call_operator && old.last_call_operator !== n.lastCallOperator) {
      alerts.push({
        id_in_cc: n.idInCc,
        country: n.country,
        old_operator: old.last_call_operator,
        old_team_leader: old.team_leader,
        old_asesor: old.asesor,
        old_horario: old.horario,
        old_substatus: old.substatus,
        old_cc_comment: old.cc_comment,
        new_operator: n.lastCallOperator,
        new_team_leader: n.teamLeader,
        new_asesor: n.asesor,
        new_horario: n.horario,
        new_substatus: n.substatus,
        new_cc_comment: n.ccComment,
      });
    }
  });
  return alerts;
}

async function recDeleteAllCurrent() {
  const res = await fetch(`${SB_URL}/rest/v1/dt_recalls?id=gte.0`, {
    method: 'DELETE',
    headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error(`Supabase delete error ${res.status}`);
}

let recBusy = false; // true durante la subida de Excel — el auto-refresh se salta el ciclo mientras tanto

async function recOnFileSelected(event) {
  const file = event.target.files[0];
  event.target.value = ''; // permite volver a elegir el mismo archivo si hace falta reintentar
  if (!file || !canEditRecalls()) return;

  const status = document.getElementById('rec-upload-status');
  status.style.color = 'var(--text-light)';
  status.textContent = 'Leyendo archivo...';
  recBusy = true;

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const parsed = recParseWorkbook(wb);
    if (parsed.length === 0) {
      status.style.color = 'var(--red)';
      status.textContent = 'No encontré filas válidas — revisa que los encabezados del Excel coincidan.';
      return;
    }

    status.textContent = `Procesando ${parsed.length} filas...`;
    const [disIdx, oldRows, excludedIds] = await Promise.all([
      recFetchDisIndex(),
      sbFetch('dt_recalls', 'select=*'),
      recFetchExcludedIds(),
    ]);
    const enrichedAll = recEnrich(parsed, disIdx);
    const skippedCount = enrichedAll.filter(r => excludedIds.has(r.idInCc)).length;
    const enriched = enrichedAll.filter(r => !excludedIds.has(r.idInCc));
    const alerts = recDetectChanges(oldRows, enriched);

    const user = getCurrentUser();

    if (alerts.length > 0) {
      status.textContent = `Guardando ${alerts.length} alerta(s) de reasignación...`;
      await bulkInsert('dt_recalls_alerts', alerts);
    }

    status.textContent = 'Actualizando tabla principal...';
    await recDeleteAllCurrent();
    const toInsert = enriched.map(r => ({
      id_in_cc: r.idInCc,
      country: r.country,
      substatus: r.substatus,
      cc_comment: r.ccComment,
      last_call_operator: r.lastCallOperator,
      team_leader: r.teamLeader,
      asesor: r.asesor,
      horario: r.horario,
      uploaded_by: user ? user[0] : null,
      uploaded_at: new Date().toISOString(),
    }));
    await bulkInsert('dt_recalls', toInsert);

    await recLoadAll();
    status.style.color = 'var(--green)';
    status.textContent = `✓ Listo — ${enriched.length} órdenes, ${alerts.length} reasignación(es) detectada(s)${skippedCount ? `, ${skippedCount} excluida(s)` : ''}`;
    setTimeout(() => { status.textContent = ''; }, 6000);
  } catch (err) {
    console.error('Error procesando Excel de Recalls:', err);
    status.style.color = 'var(--red)';
    status.textContent = 'Error al procesar el archivo, intenta de nuevo.';
  } finally {
    recBusy = false;
  }
}

async function recInitView() {
  recLoaded = true;
  document.getElementById('rec-upload-wrap').style.display = canEditRecalls() ? 'flex' : 'none';
  document.getElementById('rec-tl-note').style.display = canEditRecalls() ? 'none' : 'flex';
  document.getElementById('rec-delete-reviewed-btn').style.display = canEditRecalls() ? 'flex' : 'none';
  document.getElementById('rec-status-paste-panel').style.display = isSupervisor() ? 'block' : 'none';
  document.getElementById('rec-color-actions').style.display = isSupervisor() ? 'flex' : 'none';
  await recFetchDataLink();
  recRenderDataLinkBtn();
  await recLoadAll();
}

/* Link de "Data" — a dónde manda el botón que abre la fuente de datos en pestaña nueva.
   Se guarda en dt_data_links (misma tabla que usa "Actualización de Data") bajo section_key='recalls'.
   Cualquiera con acceso a Recalls puede abrirlo; solo Supervisor puede cambiarlo. */
async function recFetchDataLink() {
  try {
    const rows = await sbFetch('dt_data_links', 'select=*&section_key=eq.recalls');
    if (rows && rows[0]) dataLinksMap['recalls'] = rows[0];
    else delete dataLinksMap['recalls'];
  } catch (err) {
    console.error('Error cargando link de Data de Recalls:', err);
  }
}

function recRenderDataLinkBtn() {
  const btn = document.getElementById('rec-data-link-btn');
  const editBtn = document.getElementById('rec-data-edit-btn');
  if (!btn || !editBtn) return;
  const link = dataLinksMap['recalls'];
  btn.href = safeUrl(link && link.url);
  editBtn.style.display = isSupervisor() ? 'inline-flex' : 'none';
}

function recOpenDataLink(event) {
  const link = dataLinksMap['recalls'];
  if (link && link.url) return true; // deja que el <a target="_blank"> abra el link normalmente
  event.preventDefault();
  if (isSupervisor()) {
    recEditDataLink();
  } else {
    uiAlert('Aún no se ha configurado el link de Data — pide a un Supervisor que lo configure.', { title: 'Sin link de Data' });
  }
  return false;
}

async function recEditDataLink() {
  if (!isSupervisor()) return;
  await dataLinkEdit('recalls', 'Gestión de Recalls');
  recRenderDataLinkBtn();
}

async function recDeleteReviewedAlerts() {
  if (!canEditRecalls()) return;
  const reviewedCount = recAlertRows.filter(a => a.reviewed).length;
  if (reviewedCount === 0) return;
  const ok = await uiConfirm(`Se eliminarán ${reviewedCount} alerta(s) marcada(s) como revisada(s). Esta acción no se puede deshacer.`, {
    title: '¿Eliminar alertas revisadas?', confirmText: 'Eliminar', danger: true,
  });
  if (!ok) return;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/dt_recalls_alerts?reviewed=eq.true`, {
      method: 'DELETE',
      headers: SB_HEADERS,
    });
    if (!res.ok) throw new Error(`Supabase delete error ${res.status}`);
    await recLoadAll();
  } catch (err) {
    console.error('Error eliminando alertas revisadas:', err);
    uiAlert('No se pudo eliminar, intenta de nuevo.', { title: 'Error', tone: 'danger' });
  }
}

async function recLoadAll(silent = false) {
  if (!silent) {
    document.getElementById('rec-loading').style.display = 'flex';
    document.getElementById('rec-empty').style.display   = 'none';
  }

  try {
    recCurrentRows = await sbFetch('dt_recalls', 'select=*&order=id_in_cc.asc');
  } catch (err) {
    console.error('Error cargando dt_recalls:', err);
    recCurrentRows = [];
  }
  try {
    recAlertRows = await sbFetch('dt_recalls_alerts', 'select=*&order=detected_at.desc');
  } catch (err) {
    console.error('Error cargando dt_recalls_alerts:', err);
    recAlertRows = [];
  }
  recBuildAlertIndex();

  applyRecFilters();
  recUpdateDeleteCounts();
  recRenderLastUpdate();

  document.getElementById('rec-count').textContent = recCurrentRows.length;
  document.getElementById('rec-alert-count').textContent = recAlertRows.filter(a => !a.reviewed).length;
  // Tras una acción (subir Excel, marcar/borrar revisadas) los avisos de la campanita cambian
  if (!silent) notifRefresh();
}

function recClearPill(selectId, applyFn) {
  document.getElementById(selectId).value = '';
  applyFn();
}

/* Turno: agrupa el horario en 4 bloques. Post-Sale y Nocturno son horarios fijos;
   el resto se separa por la hora de inicio (mismo criterio que Stats OPs Today). */
const REC_SHIFTS = ['AM', 'Post-Sale', 'PM', 'Nocturno'];
let recActiveShift = 'AM';

function recShiftBucket(horario) {
  const h = (horario || '').trim();
  if (h.startsWith('09:00')) return 'Post-Sale';
  if (h.startsWith('22:00')) return 'Nocturno';
  const startHour = parseInt(h.slice(0, 2), 10);
  if (isNaN(startHour)) return null;
  return startHour >= 12 ? 'PM' : 'AM';
}

function recSetShift(shift) {
  // Elegir un turno puntual siempre saca de la vista global (aunque sea el mismo turno
  // que ya estaba activo antes de entrar a la vista global — por eso no se puede usar el
  // de-early-return de antes tal cual, hay que revisar si veníamos de la vista global).
  const wasGlobal = recGlobalReassignedView;
  recGlobalReassignedView = false;
  if (!wasGlobal && recActiveShift === shift) return;
  recActiveShift = shift;
  applyRecFilters();
}

/* Índice id_in_cc -> alerta más reciente, para saber si una orden está reasignada
   (pendiente) sin recorrer recAlertRows cada vez. Se reconstruye al recargar. */
let recAlertIndex = {};
function recBuildAlertIndex() {
  recAlertIndex = {};
  recAlertRows.forEach(a => { if (!recAlertIndex[a.id_in_cc]) recAlertIndex[a.id_in_cc] = a; });
}
function recIsPendingReassigned(idInCc) {
  const a = recAlertIndex[idInCc];
  return !!(a && !a.reviewed);
}

let recOnlyReassigned = false;
function recToggleOnlyReassigned() {
  recGlobalReassignedView = false; // este toggle es dentro del turno activo, no la vista global
  recOnlyReassigned = !recOnlyReassigned;
  applyRecFilters();
}

/* Vista global: TODAS las órdenes reasignadas pendientes de revisión, de todos los turnos
   a la vez, ya desglosadas en una sola tabla (sin tener que abrir Team Leader/Operador uno
   por uno) — ignora el turno activo y el toggle "Ver solo reasignadas" de arriba. */
let recGlobalReassignedView = false;
function recToggleGlobalReassignedView() {
  recGlobalReassignedView = !recGlobalReassignedView;
  if (recGlobalReassignedView) recOnlyReassigned = false; // evita el filtro doble, ya de por sí solo trae reasignadas
  applyRecFilters();
}

/* Filtro que no depende del turno (búsqueda) — se aplica antes de separar por turno,
   así los contadores de cada botón de turno ya reflejan la búsqueda activa. */
function recBaseFiltered() {
  const search = document.getElementById('rec-search').value.toLowerCase();
  return recCurrentRows.filter(r => {
    if (search) {
      const hay = `${r.id_in_cc} ${r.cc_comment} ${r.last_call_operator} ${r.substatus}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

function renderRecShiftTabs(baseRows) {
  const counts = { AM: 0, 'Post-Sale': 0, PM: 0, Nocturno: 0 };
  baseRows.forEach(r => {
    const b = recShiftBucket(r.horario);
    if (b && counts[b] !== undefined) counts[b]++;
  });
  document.querySelectorAll('.rec-shift-btn').forEach(btn => {
    const shift = btn.dataset.shift;
    // En la vista global ningún turno puntual está "activo" — todos se ven a la vez
    const active = !recGlobalReassignedView && shift === recActiveShift;
    btn.classList.toggle('btn-primary', active);
    btn.classList.toggle('btn-ghost', !active);
    const countEl = btn.querySelector('.rec-shift-count');
    if (countEl) countEl.textContent = `(${counts[shift] || 0})`;
  });
}

function renderRecOnlyReassignedToggle(shiftRows) {
  const btn = document.getElementById('rec-only-reassigned-btn');
  if (!btn) return;
  const count = shiftRows.filter(r => recIsPendingReassigned(r.id_in_cc)).length;
  const active = !recGlobalReassignedView && recOnlyReassigned;
  btn.classList.toggle('btn-primary', active);
  btn.classList.toggle('btn-ghost', !active);
  const countEl = document.getElementById('rec-only-reassigned-count');
  if (countEl) countEl.textContent = `(${count})`;
}

/* Contador del botón global: siempre cuenta sobre TODOS los turnos (baseRows, sin recortar
   por recActiveShift), sea cual sea el modo activo — así ya avisa cuántas hay en total
   incluso antes de presionarlo. */
function renderRecGlobalReassignedToggle(baseRows) {
  const btn = document.getElementById('rec-global-reassigned-btn');
  if (!btn) return;
  const count = baseRows.filter(r => recIsPendingReassigned(r.id_in_cc)).length;
  btn.classList.toggle('btn-primary', recGlobalReassignedView);
  btn.classList.toggle('btn-ghost', !recGlobalReassignedView);
  const countEl = document.getElementById('rec-global-reassigned-count');
  if (countEl) countEl.textContent = `(${count})`;
}

function applyRecFilters() {
  const search = document.getElementById('rec-search').value.toLowerCase();
  const baseRows = recBaseFiltered();
  const shiftRows = baseRows.filter(r => recShiftBucket(r.horario) === recActiveShift);

  recCurrentFiltered = recGlobalReassignedView
    ? baseRows.filter(r => recIsPendingReassigned(r.id_in_cc))
    : (recOnlyReassigned ? shiftRows.filter(r => recIsPendingReassigned(r.id_in_cc)) : shiftRows);

  document.getElementById('rec-clear-btn').style.display = search ? 'flex' : 'none';
  const sw = document.querySelector('#view-recalls .gd-search-wrap');
  if (sw) sw.classList.toggle('active', search.length > 0);

  renderRecShiftTabs(baseRows);
  renderRecOnlyReassignedToggle(shiftRows);
  renderRecGlobalReassignedToggle(baseRows);
  renderRecTree();
}

function clearRecFilters() {
  document.getElementById('rec-search').value = '';
  applyRecFilters();
}

/* Color determinístico por nombre (mismo hash siempre da el mismo color) — para Team Leader */
function recColorForName(name) {
  const s = (name || '').trim();
  if (!s || s === '—') return null;
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return { bg: `hsla(${hue},65%,55%,.16)`, color: `hsl(${hue},70%,72%)` };
}

function recTlBadge(name) {
  const v = (name || '').trim();
  if (!v || v === '—') return `<span style="color:var(--text-light)">—</span>`;
  const c = recColorForName(v);
  return `<span style="display:inline-block;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:700;background:${c.bg};color:${c.color}">${escapeHtml(v)}</span>`;
}

/* Una sola columna "Enlaces": un botón que abre un menú con Change / View */
function recLinkCells(idInCc) {
  if (!idInCc) return '<td></td>';
  return `
    <td style="text-align:center;padding:5px 4px">
      <button class="btn btn-ghost btn-sm rec-link-trigger" title="Abrir Change / View" onclick="recOpenLinkMenu(event,${jsArg(idInCc)})" style="padding:4px 6px">
        <svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
        <svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px;margin-left:1px"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
      </button>
    </td>`;
}

/* Menú flotante compartido — se posiciona junto al botón que lo abre */
function recOpenLinkMenu(evt, idInCc) {
  evt.stopPropagation();
  const menu = document.getElementById('rec-link-menu');
  const changeUrl = `https://panel.2wcall.com/order/change/${encodeURIComponent(idInCc)}`;
  const viewUrl   = `https://panel.2wcall.com/order/index/view/${encodeURIComponent(idInCc)}`;
  menu.innerHTML =
    `<a href="${changeUrl}" target="_blank" rel="noopener" class="rec-link-item">✎ Change</a>` +
    `<a href="${viewUrl}" target="_blank" rel="noopener" class="rec-link-item">👁 View</a>`;
  menu.style.display = 'block';
  const rect = evt.currentTarget.getBoundingClientRect();
  const mw = menu.offsetWidth || 140;
  menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - mw - 8)) + 'px';
  menu.style.top  = (rect.bottom + 4) + 'px';
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('rec-link-menu');
  if (!menu || menu.style.display === 'none') return;
  if (!menu.contains(e.target) && !e.target.closest('.rec-link-trigger')) menu.style.display = 'none';
});

/* Antes en gris, ahora en rojo — igual formato que ya usaba la vieja tabla de alertas */
function recArrowHTML(oldVal, newVal) {
  const o = escapeHtml(oldVal) || '—';
  const n = escapeHtml(newVal) || '—';
  return `<div style="display:flex;flex-direction:column;gap:2px;line-height:1.3">
    <span style="color:var(--text-light)">${o}</span>
    <span style="font-weight:700;color:#dc2626">${n}</span>
  </div>`;
}

/* ── Árbol Turno (ya filtrado en recCurrentFiltered) > Team Leader > Operador > Órdenes ──
   Une "Órdenes Actuales" con "Alertas" (antes dos tablas): cada fila de dt_recalls se cruza
   por id_in_cc contra dt_recalls_alerts — si hay una alerta SIN revisar, la fila se marca
   como reasignada (borde rojo) y suma al contador de su Team Leader/Operador. */
let recExpandedTLs = new Set();
let recExpandedOps = new Set();

/* Anima un contenedor .rec-tl-collapse/.rec-op-collapse deslizando su alto real
   (medido con scrollHeight) — así la duración se siente proporcional al contenido,
   no un salto instantáneo. */
function recAnimateCollapse(el, opening) {
  if (!el) return;
  if (opening) {
    el.style.maxHeight = el.scrollHeight + 'px';
  } else {
    el.style.maxHeight = el.scrollHeight + 'px'; // fija el alto actual para tener de dónde partir
    requestAnimationFrame(() => { el.style.maxHeight = '0px'; });
  }
}

function recToggleTL(ti, tlKey) {
  const opening = !recExpandedTLs.has(tlKey);
  opening ? recExpandedTLs.add(tlKey) : recExpandedTLs.delete(tlKey);
  recAnimateCollapse(document.getElementById(`rec-tlbody-${ti}`), opening);
  document.getElementById(`rec-tlchevron-${ti}`)?.classList.toggle('rec-tree-open', opening);
}

function recToggleOp(ti, oi, opKey) {
  const opEl = document.getElementById(`rec-opbody-${ti}-${oi}`);
  const opening = !recExpandedOps.has(opKey);

  // El Team Leader que contiene a este operador puede necesitar más (o menos) alto también.
  // Se calcula el destino ANTES de togglear el operador (mientras opEl todavía tiene su alto
  // viejo) sumando/restando lo que va a ganar/perder, y se aplica ya mismo junto con el toggle
  // del operador — así las dos transiciones corren en paralelo con la misma duración y el
  // contenedor del Team Leader nunca se queda con un tope viejo cortando al operador a mitad
  // de la animación (antes se medía con requestAnimationFrame un frame después, agarrando el
  // alto del operador a medio abrir, y ese tope corto se quedaba fijo — la fila se veía
  // "pegada"/cortada al abrirla).
  const tlBody = document.getElementById(`rec-tlbody-${ti}`);
  let tlTarget = null;
  if (tlBody && tlBody.style.maxHeight && tlBody.style.maxHeight !== '0px' && opEl) {
    const delta = opening ? opEl.scrollHeight : -opEl.scrollHeight;
    tlTarget = Math.max(0, tlBody.scrollHeight + delta);
  }

  opening ? recExpandedOps.add(opKey) : recExpandedOps.delete(opKey);
  recAnimateCollapse(opEl, opening);
  document.getElementById(`rec-opchevron-${ti}-${oi}`)?.classList.toggle('rec-tree-open', opening);

  if (tlTarget !== null) tlBody.style.maxHeight = tlTarget + 'px';
}

function recBuildTree(rows) {
  const byTl = {};
  rows.forEach(r => {
    const tl = r.team_leader || '—';
    if (!byTl[tl]) byTl[tl] = { teamLeader: tl, byOperator: {}, reassignedCount: 0, total: 0 };
    const op = r.last_call_operator || '—';
    if (!byTl[tl].byOperator[op]) byTl[tl].byOperator[op] = { operator: op, asesor: r.asesor || '—', rows: [], reassignedCount: 0 };

    const alert = recAlertIndex[r.id_in_cc] || null;
    const pending = !!(alert && !alert.reviewed);
    byTl[tl].byOperator[op].rows.push({ ...r, _alert: alert, _pending: pending });
    byTl[tl].total++;
    if (pending) { byTl[tl].byOperator[op].reassignedCount++; byTl[tl].reassignedCount++; }
  });

  return Object.values(byTl)
    .map(tl => ({ ...tl, operators: Object.values(tl.byOperator).sort((a, b) => a.asesor.localeCompare(b.asesor)) }))
    .sort((a, b) => a.teamLeader.localeCompare(b.teamLeader));
}

/* Textos del estado vacío — se restauran cada vez porque la vista global (más abajo)
   los pisa temporalmente con su propio mensaje. */
const REC_EMPTY_TEXT_DEFAULT = { p: 'Sin órdenes para este turno / filtro', small: 'Prueba con otro turno o quita los filtros activos' };
const REC_EMPTY_TEXT_GLOBAL  = { p: 'No hay reasignaciones pendientes', small: 'Todas las órdenes reasignadas ya fueron revisadas, en todos los turnos.' };
function recSetEmptyText(texts) {
  const empty = document.getElementById('rec-empty');
  const p = empty.querySelector('p');
  const small = empty.querySelector('small');
  if (p) p.textContent = texts.p;
  if (small) small.textContent = texts.small;
}

function renderRecTree() {
  document.getElementById('rec-loading').style.display = 'none';
  document.getElementById('rec-showing').textContent = recCurrentFiltered.length;
  document.getElementById('rec-total').textContent   = recCurrentRows.length;

  const wrap = document.getElementById('rec-tree');
  const empty = document.getElementById('rec-empty');

  // Vista global: una sola tabla plana con TODAS las reasignaciones pendientes de todos los
  // turnos, ya desglosada — sin árbol Team Leader/Operador que abrir.
  if (recGlobalReassignedView) {
    if (recCurrentFiltered.length === 0) {
      wrap.innerHTML = '';
      recSetEmptyText(REC_EMPTY_TEXT_GLOBAL);
      empty.style.display = 'flex';
      return;
    }
    empty.style.display = 'none';
    wrap.innerHTML = recRenderGlobalReassignedTable(recCurrentFiltered);
    return;
  }

  recSetEmptyText(REC_EMPTY_TEXT_DEFAULT);
  const tlGroups = recBuildTree(recCurrentFiltered);

  if (tlGroups.length === 0) {
    wrap.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';

  // El contenido de cada Team Leader/Operador se genera siempre (no solo si está expandido)
  // para que el navegador pueda medir su alto real y animar el deslizamiento al togglear.
  wrap.innerHTML = tlGroups.map((tl, ti) => {
    const tlKey = tl.teamLeader;
    const expanded = recExpandedTLs.has(tlKey);
    return `
    <div class="panel" style="margin-bottom:12px;overflow:hidden">
      <div class="rec-tl-header" style="padding:14px 20px" onclick="recToggleTL(${ti},${jsArg(tlKey)})">
        <svg class="rec-tree-chevron ${expanded ? 'rec-tree-open' : ''}" id="rec-tlchevron-${ti}" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
        ${recTlBadge(tl.teamLeader)}
        <span style="color:var(--text-light);font-size:12px">${tl.total} orden${tl.total === 1 ? '' : 'es'}</span>
        ${tl.reassignedCount > 0 ? `<span class="rec-reassigned-badge" style="margin-left:auto">🔴 ${tl.reassignedCount} reasignada${tl.reassignedCount === 1 ? '' : 's'}</span>` : ''}
      </div>
      <div class="rec-tl-collapse" id="rec-tlbody-${ti}" data-expanded="${expanded ? '1' : '0'}">
        <div style="padding:10px 14px 14px;background:var(--main-bg)">${tl.operators.map((op, oi) => recRenderOperatorBlock(ti, oi, tlKey, op)).join('')}</div>
      </div>
    </div>`;
  }).join('');

  // Fixup en dos pasadas: primero operadores (más profundo), luego Team Leaders — así el
  // alto de un TL ya cuenta el alto real de los operadores que arrancan expandidos.
  document.querySelectorAll('#rec-tree .rec-op-collapse').forEach(el => {
    if (el.dataset.expanded === '1') el.style.maxHeight = el.scrollHeight + 'px';
  });
  document.querySelectorAll('#rec-tree .rec-tl-collapse').forEach(el => {
    if (el.dataset.expanded === '1') el.style.maxHeight = el.scrollHeight + 'px';
  });
}

function recRenderOperatorBlock(ti, oi, tlKey, op) {
  const opKey = `${tlKey}::${op.operator}`;
  const expanded = recExpandedOps.has(opKey);
  return `
  <div style="margin-bottom:8px;border:1px solid var(--border);border-radius:var(--radius-sm);overflow:hidden;background:var(--card-bg)">
    <div class="rec-op-header" style="padding:10px 14px" onclick="recToggleOp(${ti},${oi},${jsArg(opKey)})">
      <svg class="rec-tree-chevron ${expanded ? 'rec-tree-open' : ''}" id="rec-opchevron-${ti}-${oi}" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
      <span style="font-weight:600;font-size:13px">${escapeHtml(op.asesor)}</span>
      <span style="font-size:10px;color:var(--text-light)">${escapeHtml(op.operator)}</span>
      <span style="color:var(--text-light);font-size:11px">${op.rows.length} orden${op.rows.length === 1 ? '' : 'es'}</span>
      ${op.reassignedCount > 0 ? `<span class="rec-reassigned-badge" style="margin-left:auto">🔴 ${op.reassignedCount}</span>` : ''}
    </div>
    <div class="rec-op-collapse" id="rec-opbody-${ti}-${oi}" data-expanded="${expanded ? '1' : '0'}">
      ${recRenderOperatorRowsTable(op.rows)}
    </div>
  </div>`;
}

function recReassignCell(r) {
  const a = r._alert;
  if (!a) return `<span style="color:var(--text-light);font-size:11px">—</span>`;
  const action = a.reviewed
    ? `<span class="badge badge-green">✓ Revisado</span>`
    : (canEditRecalls() ? `<button class="btn btn-ghost btn-sm" onclick="recMarkReviewed(${jsArg(a.id)})">Marcar revisado</button>` : `<span class="badge badge-red">Pendiente</span>`);
  return `<div style="display:flex;flex-direction:column;gap:4px;align-items:flex-start">
    ${recArrowHTML(a.old_operator, r.last_call_operator)}
    ${action}
  </div>`;
}

function recRenderOperatorRowsTable(rows) {
  return `<div class="tbl-wrap"><table>
    <thead><tr>
      <th>Id in CC</th><th>Country</th><th>Substatus</th><th>CC comment</th><th>Horario</th><th>Reasignación</th>
      <th style="width:52px;padding:12px 4px;text-align:center">Enlaces</th>
    </tr></thead>
    <tbody>${rows.map(r => {
      const statusCls = recStatusColorClass(r.status_check);
      const reassignedCls = r._pending ? 'rec-reassigned-row' : '';
      return `<tr class="${statusCls} ${reassignedCls}">
        <td><strong>${escapeHtml(r.id_in_cc) || '—'}</strong></td>
        <td>${countryFlag(r.country)}${escapeHtml(r.country) || '—'}</td>
        <td>${escapeHtml(r.substatus) || '—'}</td>
        <td style="max-width:220px;white-space:normal">${escapeHtml(r.cc_comment) || '—'}</td>
        <td>${gdScheduleBadge(r.horario)}</td>
        <td style="white-space:nowrap">${recReassignCell(r)}</td>
        ${recLinkCells(r.id_in_cc)}
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

/* ── Vista global "Ver TODAS las reasignadas": una sola tabla plana con Team Leader y
   Operador como columnas (en vez de agrupar en árbol) — ordenada por Team Leader > Operador
   > Id in CC para que sea fácil de escanear de un vistazo, con todo ya visible sin togglear
   nada. Las filas que llegan acá ya son 100% reasignadas pendientes (recCurrentFiltered en
   modo global las filtra así), así que recReassignCell siempre va a tener alerta. ── */
function recRenderGlobalReassignedTable(rows) {
  const sorted = [...rows].sort((a, b) => {
    const tl = (a.team_leader || '—').localeCompare(b.team_leader || '—');
    if (tl !== 0) return tl;
    const op = (a.asesor || '—').localeCompare(b.asesor || '—');
    if (op !== 0) return op;
    return (a.id_in_cc || '').localeCompare(b.id_in_cc || '');
  });

  return `<div class="tbl-wrap"><table>
    <thead><tr>
      <th>Team Leader</th><th>Operador</th><th>Turno</th><th>Id in CC</th><th>Country</th><th>Substatus</th><th>CC comment</th><th>Horario</th><th>Reasignación</th>
      <th style="width:52px;padding:12px 4px;text-align:center">Enlaces</th>
    </tr></thead>
    <tbody>${sorted.map(r => {
      const statusCls = recStatusColorClass(r.status_check);
      const augmented = { ...r, _alert: recAlertIndex[r.id_in_cc] || null };
      return `<tr class="${statusCls} rec-reassigned-row">
        <td>${recTlBadge(r.team_leader)}</td>
        <td style="white-space:nowrap"><span style="font-weight:600">${escapeHtml(r.asesor) || '—'}</span> <span style="font-size:10px;color:var(--text-light)">${escapeHtml(r.last_call_operator) || '—'}</span></td>
        <td style="white-space:nowrap;color:var(--text-light);font-size:11px">${recShiftBucket(r.horario) || '—'}</td>
        <td><strong>${escapeHtml(r.id_in_cc) || '—'}</strong></td>
        <td>${countryFlag(r.country)}${escapeHtml(r.country) || '—'}</td>
        <td>${escapeHtml(r.substatus) || '—'}</td>
        <td style="max-width:220px;white-space:normal">${escapeHtml(r.cc_comment) || '—'}</td>
        <td>${gdScheduleBadge(r.horario)}</td>
        <td style="white-space:nowrap">${recReassignCell(augmented)}</td>
        ${recLinkCells(r.id_in_cc)}
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

/* ── Copiar Id in CC visibles al portapapeles, en grupos de REC_COPY_CHUNK_SIZE
   (el sistema externo donde se pegan no acepta bloques muy grandes de una vez) ── */
const REC_COPY_CHUNK_SIZE = 150;
const REC_COPY_ORDINALS = ['primeros', 'segundos', 'terceros', 'cuartos', 'quintos', 'sextos', 'séptimos', 'octavos', 'novenos', 'décimos'];

/* Config de copiar IDs — ahora una sola tabla unificada */
const REC_COPY_CFG = {
  main: { menuId: 'rec-copy-menu', btnId: 'rec-copy-ids-btn', labelId: 'rec-copy-ids-label', src: () => recCurrentFiltered },
};

function recToggleCopyMenu(evt, which = 'main') {
  evt.stopPropagation();
  const cfg = REC_COPY_CFG[which];
  const menu = document.getElementById(cfg.menuId);
  const opening = menu.style.display === 'none';
  // cerrar el otro menú de copiar si estaba abierto
  Object.values(REC_COPY_CFG).forEach(c => { if (c.menuId !== cfg.menuId) document.getElementById(c.menuId).style.display = 'none'; });
  if (opening) {
    recRenderCopyMenu(which);
    menu.style.display = 'block';
  } else {
    menu.style.display = 'none';
  }
}

document.addEventListener('click', (e) => {
  Object.values(REC_COPY_CFG).forEach(cfg => {
    const menu = document.getElementById(cfg.menuId);
    if (!menu || menu.style.display === 'none') return;
    if (!menu.contains(e.target) && !e.target.closest('#' + cfg.btnId)) menu.style.display = 'none';
  });
});

function recRenderCopyMenu(which = 'main') {
  const cfg = REC_COPY_CFG[which];
  const menu = document.getElementById(cfg.menuId);
  const total = cfg.src().filter(r => r.id_in_cc).length;

  if (total === 0) {
    menu.innerHTML = `<div class="rec-copy-menu-item" style="cursor:default;color:var(--text-light)">No hay IDs para copiar</div>`;
    return;
  }

  let items = '';
  for (let start = 0; start < total; start += REC_COPY_CHUNK_SIZE) {
    const end = Math.min(start + REC_COPY_CHUNK_SIZE, total);
    const count = end - start;
    const groupIdx = start / REC_COPY_CHUNK_SIZE;
    const label = REC_COPY_ORDINALS[groupIdx] || `grupo ${groupIdx + 1}`;
    items += `<div class="rec-copy-menu-item" onclick="recCopyIdsChunk(${start},${end},'${which}')">
      <span>Copiar ${label} ${count} IDs</span>
      <span class="rec-copy-menu-range">${start + 1}–${end}</span>
    </div>`;
  }
  if (total > REC_COPY_CHUNK_SIZE) {
    items += `<div class="rec-copy-menu-item all" onclick="recCopyIdsChunk(0,${total},'${which}')">
      <span>Copiar todos (${total})</span>
    </div>`;
  }
  menu.innerHTML = items;
}

async function recCopyIdsChunk(start, end, which = 'main') {
  const cfg = REC_COPY_CFG[which];
  const ids = cfg.src().map(r => r.id_in_cc).filter(Boolean).slice(start, end);
  document.getElementById(cfg.menuId).style.display = 'none';
  if (ids.length === 0) return;
  const text = ids.join(' ');
  const label = document.getElementById(cfg.labelId);
  const original = label.textContent;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    label.textContent = `✓ ${ids.length} copiados`;
    setTimeout(() => { label.textContent = original; }, 2000);
  } catch (err) {
    console.error('Error copiando al portapapeles:', err);
    uiAlert('No se pudo copiar al portapapeles.', { title: 'Error', tone: 'danger' });
  }
}

/* ── Comparar Status: pega una exportación con columnas "#" (Id in CC) y "Status" ── */
function recToggleStatusPaste() {
  const body = document.getElementById('rec-status-paste-body');
  const chevron = document.getElementById('rec-status-paste-chevron');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  chevron.style.transform = open ? 'rotate(-90deg)' : 'rotate(0deg)';
}

function recParseStatusPaste(raw) {
  const lines = raw.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim() !== '');
  if (lines.length < 2) return [];
  const headerCells = lines[0].split('\t');
  const idIdx = headerCells.findIndex(h => h.trim() === '#');
  const statusIdx = headerCells.findIndex(h => h.trim().toLowerCase() === 'status');
  if (idIdx === -1 || statusIdx === -1) return [];

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const id = (cells[idIdx] || '').trim();
    const status = (cells[statusIdx] || '').trim();
    if (id) rows.push({ id, status });
  }
  return rows;
}

/* Rojo/Amarillo/sin color según el Status recién pegado */
function recStatusColorClass(statusCheck) {
  const s = (statusCheck || '').trim().toLowerCase();
  if (!s || s === 'recall') return '';
  if (s === 'no answer') return 'rec-status-yellow';
  if (s === 'reject' || s === 'approved' || s === 'trash') return 'rec-status-red';
  return '';
}

async function recUpdateStatusCheck(ids, statusValue) {
  const idsParam = ids.map(id => encodeURIComponent(id)).join(',');
  const res = await fetch(`${SB_URL}/rest/v1/dt_recalls?id_in_cc=in.(${idsParam})`, {
    method: 'PATCH',
    headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ status_check: statusValue }),
  });
  if (!res.ok) throw new Error(`Supabase update error ${await acctErrorDetail(res)}`);
}

async function recUpdateAlertStatusCheck(ids, statusValue) {
  const idsParam = ids.map(id => encodeURIComponent(id)).join(',');
  const res = await fetch(`${SB_URL}/rest/v1/dt_recalls_alerts?id_in_cc=in.(${idsParam})`, {
    method: 'PATCH',
    headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ status_check: statusValue }),
  });
  if (!res.ok) throw new Error(`Supabase update error (alertas) ${await acctErrorDetail(res)}`);
}

async function recCompareStatus() {
  if (!isSupervisor()) return;
  const raw = document.getElementById('rec-status-raw-input').value;
  const errBox = document.getElementById('rec-status-parse-error');
  const statusEl = document.getElementById('rec-status-compare-status');
  errBox.style.display = 'none';
  statusEl.textContent = '';

  const parsed = recParseStatusPaste(raw);
  if (parsed.length === 0) {
    errBox.textContent = 'No pude reconocer filas válidas — revisa que hayas pegado el bloque con encabezado, incluyendo las columnas "#" y "Status".';
    errBox.style.display = 'flex';
    return;
  }

  // Se compara contra AMBAS tablas: órdenes actuales y reasignaciones
  const currentIds = new Set(recCurrentRows.map(r => r.id_in_cc));
  const alertIds   = new Set(recAlertRows.map(a => a.id_in_cc));
  const mainMatches  = parsed.filter(p => currentIds.has(p.id));
  const alertMatches = parsed.filter(p => alertIds.has(p.id));
  const totalMatched = new Set([...mainMatches, ...alertMatches].map(m => m.id)).size;

  if (totalMatched === 0) {
    statusEl.style.color = 'var(--text-light)';
    statusEl.textContent = 'Ningún Id in CC de lo pegado coincide con las tablas actuales.';
    return;
  }

  statusEl.style.color = 'var(--text-light)';
  statusEl.textContent = `Actualizando ${totalMatched} orden(es)...`;

  const groupByStatus = (arr) => {
    const m = {};
    arr.forEach(x => { const k = x.status || ''; (m[k] = m[k] || []).push(x.id); });
    return m;
  };
  const byStatusMain  = groupByStatus(mainMatches);
  const byStatusAlert = groupByStatus(alertMatches);

  try {
    for (const [statusValue, ids] of Object.entries(byStatusMain)) {
      await recUpdateStatusCheck(ids, statusValue);
    }
    for (const [statusValue, ids] of Object.entries(byStatusAlert)) {
      await recUpdateAlertStatusCheck(ids, statusValue);
    }
    await recLoadAll();
    statusEl.style.color = 'var(--green)';
    statusEl.textContent = `✓ ${totalMatched} orden(es) actualizadas`;
    setTimeout(() => { statusEl.textContent = ''; }, 6000);
    recToggleStatusPaste();
  } catch (err) {
    console.error('Error comparando status:', err);
    statusEl.style.color = 'var(--red)';
    statusEl.textContent = (err && err.message) ? err.message : 'Error al actualizar, intenta de nuevo.';
  }
}

/* ── Eliminar por color + exclusión permanente (no se vuelven a cargar en futuras subidas) ── */
function recColorGroup(row) {
  const cls = recStatusColorClass(row.status_check);
  if (cls === 'rec-status-yellow') return 'yellow';
  if (cls === 'rec-status-red') return 'red';
  return null;
}

async function recFetchExcludedIds() {
  try {
    const rows = await sbFetch('dt_recalls_excluded', 'select=id_in_cc');
    return new Set(rows.map(r => r.id_in_cc));
  } catch (err) {
    console.error('Error cargando exclusiones de Recalls:', err);
    return new Set();
  }
}

async function recDeleteByStatusColor(color) {
  if (!isSupervisor()) return;
  const ids = recCurrentRows.filter(r => recColorGroup(r) === color).map(r => r.id_in_cc);
  if (ids.length === 0) return;
  const label = color === 'yellow' ? 'amarillas' : 'rojas';
  const ok = await uiConfirm(`Se eliminarán ${ids.length} orden(es) marcadas en ${label}. No se van a volver a cargar aunque aparezcan en un Excel futuro.`, {
    title: `¿Eliminar órdenes ${label}?`, confirmText: 'Eliminar', danger: true,
  });
  if (!ok) return;

  try {
    const excludeRows = ids.map(id => ({ id_in_cc: id, reason: color }));
    await fetch(`${SB_URL}/rest/v1/dt_recalls_excluded?on_conflict=id_in_cc`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify(excludeRows),
    });

    const idsParam = ids.map(id => encodeURIComponent(id)).join(',');
    const res = await fetch(`${SB_URL}/rest/v1/dt_recalls?id_in_cc=in.(${idsParam})`, {
      method: 'DELETE',
      headers: SB_HEADERS,
    });
    if (!res.ok) throw new Error(`Supabase delete error ${res.status}`);

    await recLoadAll();
  } catch (err) {
    console.error('Error eliminando órdenes por color:', err);
    uiAlert('No se pudo eliminar, intenta de nuevo.', { title: 'Error', tone: 'danger' });
  }
}

/* Caja azul: quién y cuándo hizo la última carga de data (todas las filas comparten estos valores) */
function recRenderLastUpdate() {
  const box = document.getElementById('rec-lastupd-box');
  const first = recCurrentRows[0];
  if (!first || !first.uploaded_by) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  document.getElementById('rec-lastupd-name').textContent = first.uploaded_by;
  const t = first.uploaded_at ? new Date(first.uploaded_at) : null;
  document.getElementById('rec-lastupd-time').textContent = t
    ? `${t.toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'})} · ${t.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}`
    : '';
}

/* Actualiza el número que muestran los botones de eliminar (antes de presionarlos) */
function recUpdateDeleteCounts() {
  const cnt = (rows, color) => rows.filter(r => recColorGroup(r) === color).length;
  const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  setTxt('rec-del-yellow', `Eliminar amarillas (${cnt(recCurrentRows, 'yellow')})`);
  setTxt('rec-del-red',    `Eliminar rojas (${cnt(recCurrentRows, 'red')})`);
  setTxt('rec-reviewed-n', `(${recAlertRows.filter(a => a.reviewed).length})`);
}

async function recMarkReviewed(id) {
  if (!canEditRecalls()) return;
  const user = getCurrentUser();
  try {
    const res = await fetch(`${SB_URL}/rest/v1/dt_recalls_alerts?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ reviewed: true, reviewed_by: user ? user[0] : null, reviewed_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`update error ${res.status}`);
    await recLoadAll();
  } catch (err) {
    console.error('Error marcando alerta como revisada:', err);
    uiAlert('No se pudo marcar como revisado, intenta de nuevo.', { title: 'Error', tone: 'danger' });
  }
}
