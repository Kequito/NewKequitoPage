/* Vista Gestión de Recalls — carga del Excel (con vista previa), indicadores, árbol Turno › Team Leader ›
   Operador › Órdenes, reasignaciones, "Copiar" por TL / OP, Comparar Status, exclusiones e historial.

   La carga del Excel se hace en Supabase DE UNA SOLA VEZ (supabase/12_recalls.sql: rec_preview / rec_replace):
   si algo falla a mitad no se cambia nada, se conservan los colores de "Comparar Status" y queda en el historial.
   Todo se lee por partes (sbFetchAll): Supabase entrega máximo 1000 filas por consulta. */

const REC_FIELD_MAP = {
  'id in cc':            'idInCc',
  'country':             'country',
  'substatus':           'substatus',
  'cc comment':          'ccComment',
  'last call operator':  'lastCallOperator',
};
const REC_REQUIRED = { 'id in cc': 'Id in CC', 'last call operator': 'Last Call Operator' };

let recLoaded          = false;
let recCurrentRows     = [];   // dt_recalls
let recCurrentFiltered = [];   // lo que se ve (alcance + filtros + turno)
let recAlertRows       = [];   // dt_recalls_alerts (más recientes primero)
let recExcludedRows    = [];   // dt_recalls_excluded
let recUploads         = null; // dt_recalls_cargas (null = no existe todavía: falta el script 12)
let recBusy            = false; // true durante la subida — el auto-refresh se salta el ciclo

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

/* Si el Excel no trae filas válidas: qué columnas faltan (para un mensaje útil) */
function recMissingColumnsText(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!raw.length) return 'El archivo está vacío.';
  const have = Object.keys(raw[0]).map(recNormalizeHeader);
  const missing = Object.entries(REC_REQUIRED).filter(([k]) => !have.includes(k)).map(([, label]) => label);
  return missing.length
    ? `Al archivo le falta la columna ${missing.join(' y ')}. Columnas que trae: ${Object.keys(raw[0]).slice(0, 8).join(', ')}${Object.keys(raw[0]).length > 8 ? '…' : ''}.`
    : 'Ninguna fila tiene "Id in CC". Revisa que sea el archivo correcto.';
}

/* Índice PEROP1AM -> {teamLeader, asesor, horario}, mismo origen que Equipos 360 / Approve Stats */
async function recFetchDisIndex() {
  try {
    const rows = await sbFetchAll('dt_dis', 'select=PEROP1AM,ASESORES,TEAMLEADER,HORARIO&order=PEROP1AM.asc');
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
      id_in_cc: r.idInCc, country: r.country, substatus: r.substatus, cc_comment: r.ccComment,
      last_call_operator: r.lastCallOperator,
      team_leader: info.teamLeader || '—', asesor: info.asesor || '—', horario: info.horario || '—',
    };
  });
}

function recErrorText(err) {
  const m = (err && err.message) || '';
  if (/rec_preview|rec_replace/.test(m) && /find|encontr|schema/i.test(m)) return 'Falta correr en Supabase el script 12 (Recalls).';
  if (!m || (err && err.name === 'TypeError')) return 'No se pudo conectar con Supabase. Revisa tu internet e intenta de nuevo.';
  return m;
}

/* ══════════════════════════════
   SUBIR EXCEL — leer → comparar (vista previa) → confirmar → reemplazar de una sola vez
══════════════════════════════ */
async function recOnFileSelected(event) {
  const file = event.target.files[0];
  event.target.value = ''; // permite volver a elegir el mismo archivo
  if (!file || !can('recalls.upload')) return;

  const status = document.getElementById('rec-upload-status');
  const say = (text, color = 'var(--text-light)') => { status.style.color = color; status.textContent = text; status.title = text; };
  recBusy = true;
  try {
    say('Leyendo archivo...');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const parsed = recParseWorkbook(wb);
    if (parsed.length === 0) { say(recMissingColumnsText(wb), 'var(--red)'); return; }

    say(`Comparando ${parsed.length} filas con las órdenes actuales...`);
    const rows = recEnrich(parsed, await recFetchDisIndex());
    const preview = await sbRpc('rec_preview', { p_rows: rows });
    say('');
    if (!(await recConfirmUpload(file.name, preview))) { say('Carga cancelada — no se cambió nada.'); setTimeout(() => say(''), 5000); return; }

    say('Guardando...');
    const res = await sbRpc('rec_replace', { p_rows: rows, p_archivo: file.name });
    await recLoadAll();
    say(`✓ Listo — ${res.total} órdenes · ${res.nuevas} nuevas · ${res.salieron} salieron · ${res.reasignadas} reasignada(s)${res.excluidas ? ` · ${res.excluidas} excluida(s)` : ''}`, 'var(--green)');
    setTimeout(() => say(''), 9000);
  } catch (err) {
    console.error('Error procesando Excel de Recalls:', err);
    say(`No se pudo cargar: ${recErrorText(err)}`, 'var(--red)');
  } finally {
    recBusy = false;
  }
}

/* Vista previa: qué va a cambiar si se confirma */
async function recConfirmUpload(fileName, p) {
  const body = uiEl('div', 'rec-preview');
  const tile = (label, value, cls = '') => `<div class="rec-pv-tile ${cls}"><span>${label}</span><b>${Number(value || 0).toLocaleString('es-PE')}</b></div>`;
  const outShare = p.anteriores ? p.salieron / p.anteriores : 0;
  const sample = p.muestra || [];
  body.innerHTML = `
    <div class="rec-pv-file">📄 ${escapeHtml(fileName)}</div>
    <div class="rec-pv-tiles">
      ${tile('Quedarán cargadas', p.total, 'is-main')}
      ${tile('Nuevas', p.nuevas, 'is-good')}
      ${tile('Salen', p.salieron, p.salieron ? 'is-warn' : '')}
      ${tile('Se mantienen', p.mantienen)}
      ${tile('Reasignadas', p.reasignadas, p.reasignadas ? 'is-bad' : '')}
      ${tile('Excluidas (no se cargan)', p.excluidas)}
    </div>
    ${outShare > 0.5 && p.anteriores >= 20 ? `<div class="perm-acct-warn">⚠ Salen ${p.salieron} de las ${p.anteriores} órdenes que hay ahora (${Math.round(outShare * 100)}%). ¿Es el archivo correcto?</div>` : ''}
    ${sample.length ? `<div class="rec-pv-sec">Reasignaciones que se van a marcar${p.reasignadas > sample.length ? ` (primeras ${sample.length} de ${p.reasignadas})` : ''}</div>
      <div class="rec-pv-list">${sample.map(s => `<div><strong>${escapeHtml(s.id)}</strong> <span class="rec-arrow-old">${escapeHtml(s.de || s.de_op || '—')}</span> → <span class="rec-arrow-new">${escapeHtml(s.a || s.a_op || '—')}</span></div>`).join('')}</div>` : ''}
    <p class="rec-pv-note">Los colores de "Comparar Status" de las órdenes que se mantienen se conservan. Si algo falla al guardar, no se cambia nada.</p>`;
  return uiDialog({ title: 'Revisar antes de reemplazar', body, wide: true, confirmText: 'Reemplazar órdenes', tone: 'warning' });
}

/* ══════════════════════════════
   CARGA DE DATOS
══════════════════════════════ */
async function recInitView() {
  recLoaded = true;
  document.getElementById('rec-upload-wrap').style.display = can('recalls.upload') ? 'flex' : 'none';
  document.getElementById('rec-tl-note').style.display = can('recalls.upload') ? 'none' : 'flex';
  document.getElementById('rec-delete-reviewed-btn').style.display = can('recalls.review') ? 'flex' : 'none';
  document.getElementById('rec-color-actions').style.display = can('recalls.compare') ? 'flex' : 'none';
  recRestoreExpanded();
  await recFetchDataLink();
  recRenderDataLinkBtn();
  await recLoadAll();
}

let recLoadingHTML = null;   // contenido original de #rec-loading (se reemplaza por el error y vuelve al reintentar)

async function recLoadAll(silent = false) {
  const loadingBox = document.getElementById('rec-loading');
  if (recLoadingHTML === null) recLoadingHTML = loadingBox.innerHTML;
  if (!silent) {
    loadingBox.innerHTML = recLoadingHTML;
    loadingBox.style.display = 'flex';
    document.getElementById('rec-empty').style.display = 'none';
  }
  const safe = (p, fallback, what) => p.catch(err => { console.error(`Error cargando ${what}:`, err); return fallback; });
  // Órdenes y alertas son obligatorias: sin ellas NO se dibuja nada (se veía "sin órdenes" como si estuviera vacío)
  const must = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));
  const [rowsR, alertsR, excluded, uploads] = await Promise.all([
    must(sbFetchAll('dt_recalls', 'select=*&order=id_in_cc.asc')),
    must(sbFetchAll('dt_recalls_alerts', 'select=*&order=detected_at.desc,id.desc')),
    can('recalls.compare') ? safe(sbFetchAll('dt_recalls_excluded', 'select=*&order=id_in_cc.asc'), [], 'dt_recalls_excluded') : Promise.resolve([]),
    safe(sbFetch('dt_recalls_cargas', 'select=*&order=subido_at.desc&limit=30'), null, 'dt_recalls_cargas'),
  ]);
  if (!rowsR.ok || !alertsR.ok) {
    console.error('Error cargando Recalls:', rowsR.e || alertsR.e);
    if (silent) return;   // refresco automático: se queda lo que ya se estaba viendo
    loadingBox.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
      <p>No se pudieron cargar las órdenes</p><small>Revisa tu conexión a internet.</small>${uiRetryButton('recLoadAll()')}`;
    loadingBox.style.display = 'flex';
    return;
  }
  const rows = rowsR.v, alerts = alertsR.v;
  recCurrentRows = rows;
  recAlertRows = alerts;
  recExcludedRows = excluded;
  recUploads = uploads;
  recBuildAlertIndex();
  recMyTeam = undefined;   // se recalcula con los Team Leaders de esta carga

  recRenderScopeSeg();
  recPopulateFilters();
  applyRecFilters();
  recUpdateDeleteCounts();
  recRenderLastUpdate();
  recRenderTools();
  // Tras una acción (subir Excel, marcar/borrar revisadas) los avisos de la campanita cambian
  if (!silent) notifRefresh();
}

/* ── Link de "Data" (dt_data_links, section_key='recalls') ── */
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
  editBtn.style.display = can('datalinks.edit') ? 'inline-flex' : 'none';
}

function recOpenDataLink(event) {
  const link = dataLinksMap['recalls'];
  if (link && link.url) return true; // deja que el <a target="_blank"> abra el link normalmente
  event.preventDefault();
  if (can('datalinks.edit')) recEditDataLink();
  else uiAlert('Aún no se ha configurado el link de Data — pide a quien gestiona los links de Data que lo configure.', { title: 'Sin link de Data' });
  return false;
}

async function recEditDataLink() {
  if (!can('datalinks.edit')) return;
  await dataLinkEdit('recalls', 'Gestión de Recalls');
  recRenderDataLinkBtn();
}

/* ══════════════════════════════
   REASIGNACIONES — índice, revisar (una o varias), borrar revisadas
══════════════════════════════ */
let recAlertIndex = {};   // id_in_cc → alerta MÁS RECIENTE
let recAlertChain = {};   // id_in_cc → todas sus alertas (más recientes primero)
function recBuildAlertIndex() {
  recAlertIndex = {};
  recAlertChain = {};
  recAlertRows.forEach(a => {
    if (!recAlertIndex[a.id_in_cc]) recAlertIndex[a.id_in_cc] = a;
    (recAlertChain[a.id_in_cc] = recAlertChain[a.id_in_cc] || []).push(a);
  });
}
function recIsPendingReassigned(idInCc) {
  const a = recAlertIndex[idInCc];
  return !!(a && !a.reviewed);
}

async function recPatchAlertsReviewed(alertIds) {
  const user = getCurrentUser();
  const body = JSON.stringify({ reviewed: true, reviewed_by: user ? user[0] : null, reviewed_at: new Date().toISOString() });
  for (let i = 0; i < alertIds.length; i += REC_ID_BATCH) {
    const res = await fetch(`${SB_URL}/rest/v1/dt_recalls_alerts?id=in.(${alertIds.slice(i, i + REC_ID_BATCH).join(',')})`, {
      method: 'PATCH',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body,
    });
    if (!res.ok) throw new Error(`No se pudo marcar como revisado (${await acctErrorDetail(res)})`);
  }
}

async function recMarkReviewed(id) {
  if (!can('recalls.review')) return;
  try {
    await recPatchAlertsReviewed([id]);
    await recLoadAll(true);
    notifRefresh();
  } catch (err) {
    console.error('Error marcando alerta como revisada:', err);
    uiAlert(err.message || 'No se pudo marcar como revisado, intenta de nuevo.', { title: 'Error', tone: 'danger' });
  }
}

/* Marca revisadas TODAS las reasignaciones pendientes de un grupo de órdenes (un Team Leader o un Operador) */
async function recMarkGroupReviewed(kind, tlKey, opKey) {
  if (!can('recalls.review')) return;
  const rows = recRowsOf(kind, tlKey, opKey).filter(r => recIsPendingReassigned(r.id_in_cc));
  const alertIds = [...new Set(rows.flatMap(r => (recAlertChain[r.id_in_cc] || []).filter(a => !a.reviewed).map(a => a.id)))];
  if (!alertIds.length) return;
  const who = kind === 'tl' ? `el equipo de ${tlKey}` : (rows[0] && rows[0].asesor) || opKey;
  const ok = await uiConfirm(`Se marcarán como revisadas ${rows.length} orden(es) reasignada(s) de ${who}.`, { title: '¿Marcar todas como revisadas?', confirmText: 'Marcar revisadas' });
  if (!ok) return;
  try {
    await recPatchAlertsReviewed(alertIds);
    await recLoadAll(true);
    notifRefresh();
  } catch (err) {
    console.error('Error marcando revisadas:', err);
    uiAlert(err.message || 'No se pudo marcar, intenta de nuevo.', { title: 'Error', tone: 'danger' });
  }
}

async function recDeleteReviewedAlerts() {
  if (!can('recalls.review')) return;
  const reviewedCount = recAlertRows.filter(a => a.reviewed).length;
  if (reviewedCount === 0) return;
  const ok = await uiConfirm(`Se eliminarán ${reviewedCount} alerta(s) marcada(s) como revisada(s). Esta acción no se puede deshacer.`, {
    title: '¿Eliminar alertas revisadas?', confirmText: 'Eliminar', danger: true,
  });
  if (!ok) return;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/dt_recalls_alerts?reviewed=eq.true`, { method: 'DELETE', headers: SB_HEADERS });
    if (!res.ok) throw new Error(`No se pudo eliminar (${await acctErrorDetail(res)})`);
    await recLoadAll();
  } catch (err) {
    console.error('Error eliminando alertas revisadas:', err);
    uiAlert(err.message || 'No se pudo eliminar, intenta de nuevo.', { title: 'Error', tone: 'danger' });
  }
}

/* ══════════════════════════════
   ALCANCE ("Mi equipo" / "Mis órdenes") Y FILTROS
══════════════════════════════ */
let recScope = 'mine';      // Team Leader: 'mine' (su equipo) | 'all'
let recMyTeam = undefined;  // nombre del Team Leader de la cuenta (undefined = sin calcular, null = no encontrado)

/* El Team Leader de la cuenta, buscado por nombre entre los Team Leaders de las órdenes (mismo criterio que Top TL) */
function recMyTeamName() {
  if (recMyTeam !== undefined) return recMyTeam;
  const tls = [...new Set(recCurrentRows.map(r => r.team_leader).filter(t => t && t !== '—'))];
  const me = tlFindMe(tls.map(t => ({ teamLeader: t })));
  recMyTeam = me ? me.teamLeader : null;
  return recMyTeam;
}

/* Órdenes que esta cuenta ve: Operador → solo las suyas · TL → su equipo (o todo) · resto → todo */
function recScopeRows(rows) {
  const role = currentRole();
  if (role === 'operador') {
    const me = getCurrentUser();
    const perop = ((me && me[1]) || '').trim();
    const num = sheetOperatorNumber(perop);
    return rows.filter(r => {
      const op = (r.last_call_operator || '').trim();
      return (perop && op === perop) || (num && sheetOperatorNumber(op) === num);
    });
  }
  if (role === 'team leader' && recScope === 'mine') {
    const team = recMyTeamName();
    if (team) return rows.filter(r => r.team_leader === team);
  }
  return rows;
}

function recRenderScopeSeg() {
  const seg = document.getElementById('rec-scope-seg');
  const role = currentRole();
  if (role === 'operador') {
    seg.hidden = false;
    seg.innerHTML = '<span class="rec-scope-label">👤 Tus órdenes</span>';
    return;
  }
  if (role !== 'team leader') { seg.hidden = true; return; }
  const team = recMyTeamName();
  seg.hidden = false;
  seg.innerHTML = team
    ? [['mine', `👥 Mi equipo`], ['all', '🌐 Todos']].map(([v, l]) =>
        `<button type="button" class="eq-seg-btn ${recScope === v ? 'active' : ''}" onclick="recSetScope('${v}')">${l}</button>`).join('')
    : '<span class="rec-scope-label" title="No encontré tu nombre entre los Team Leaders de las órdenes">🌐 Todos los equipos</span>';
}

function recSetScope(v) {
  recScope = v === 'all' ? 'all' : 'mine';
  recRenderScopeSeg();
  recPopulateFilters();
  applyRecFilters();
}

function recPopulateFilters() {
  const scoped = recScopeRows(recCurrentRows);
  const fill = (id, label, values) => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = `<option value="">${label}: todos</option>` + values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    sel.value = values.includes(prev) ? prev : '';
  };
  const uniq = key => [...new Set(scoped.map(r => (r[key] || '').trim()).filter(v => v && v !== '—'))].sort((a, b) => a.localeCompare(b));
  fill('rec-f-tl', 'Team Leader', uniq('team_leader'));
  fill('rec-f-country', 'País', uniq('country'));
  fill('rec-f-substatus', 'Substatus', uniq('substatus'));
  // Un Operador solo ve lo suyo: el filtro de Team Leader no aporta nada
  document.getElementById('rec-f-tl').hidden = currentRole() === 'operador';
}

/* Alcance + búsqueda + filtros (sin el turno): así los contadores de cada turno ya respetan todo lo demás */
function recBaseFiltered() {
  const v = id => document.getElementById(id).value;
  const search = document.getElementById('rec-search').value.trim().toLowerCase();
  const tl = v('rec-f-tl'), country = v('rec-f-country'), sub = v('rec-f-substatus'), color = v('rec-f-color');
  return recScopeRows(recCurrentRows).filter(r => {
    if (tl && r.team_leader !== tl) return false;
    if (country && (r.country || '').trim() !== country) return false;
    if (sub && (r.substatus || '').trim() !== sub) return false;
    if (color) {
      const g = recColorGroup(r);
      if (color === 'none' ? g : g !== color) return false;
    }
    if (search) {
      const hay = `${r.id_in_cc} ${r.cc_comment} ${r.last_call_operator} ${r.substatus} ${r.asesor} ${r.team_leader}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

function recFiltersActive() {
  return ['rec-f-tl', 'rec-f-country', 'rec-f-substatus', 'rec-f-color'].some(id => document.getElementById(id).value)
    || !!document.getElementById('rec-search').value.trim();
}

function clearRecFilters() {
  document.getElementById('rec-search').value = '';
  ['rec-f-tl', 'rec-f-country', 'rec-f-substatus', 'rec-f-color'].forEach(id => { document.getElementById(id).value = ''; });
  applyRecFilters();
}

/* (la usa también Approve Stats para sus pills) */
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
  // Elegir un turno siempre saca de la vista global (aunque sea el mismo turno que ya estaba activo)
  const wasGlobal = recGlobalReassignedView;
  recGlobalReassignedView = false;
  if (!wasGlobal && recActiveShift === shift) return;
  recActiveShift = shift;
  applyRecFilters();
}

let recOnlyReassigned = false;
function recToggleOnlyReassigned() {
  recGlobalReassignedView = false; // este toggle es dentro del turno activo, no la vista global
  recOnlyReassigned = !recOnlyReassigned;
  applyRecFilters();
}

/* Vista global: TODAS las reasignadas pendientes de todos los turnos, en una sola tabla plana */
let recGlobalReassignedView = false;
function recToggleGlobalReassignedView() {
  recGlobalReassignedView = !recGlobalReassignedView;
  if (recGlobalReassignedView) recOnlyReassigned = false;
  applyRecFilters();
}

function renderRecShiftTabs(baseRows) {
  const counts = { AM: 0, 'Post-Sale': 0, PM: 0, Nocturno: 0 };
  baseRows.forEach(r => { const b = recShiftBucket(r.horario); if (b && counts[b] !== undefined) counts[b]++; });
  document.querySelectorAll('.rec-shift-btn').forEach(btn => {
    const shift = btn.dataset.shift;
    const active = !recGlobalReassignedView && shift === recActiveShift;
    btn.classList.toggle('btn-primary', active);
    btn.classList.toggle('btn-ghost', !active);
    const countEl = btn.querySelector('.rec-shift-count');
    if (countEl) countEl.textContent = `(${counts[shift] || 0})`;
  });
}

function renderRecReassignToggles(baseRows, shiftRows) {
  const set = (btnId, countId, active, n) => {
    const btn = document.getElementById(btnId);
    btn.classList.toggle('btn-primary', active);
    btn.classList.toggle('btn-ghost', !active);
    document.getElementById(countId).textContent = `(${n})`;
  };
  set('rec-only-reassigned-btn', 'rec-only-reassigned-count', !recGlobalReassignedView && recOnlyReassigned,
    shiftRows.filter(r => recIsPendingReassigned(r.id_in_cc)).length);
  set('rec-global-reassigned-btn', 'rec-global-reassigned-count', recGlobalReassignedView,
    baseRows.filter(r => recIsPendingReassigned(r.id_in_cc)).length);
}

function applyRecFilters() {
  const baseRows = recBaseFiltered();
  const shiftRows = baseRows.filter(r => recShiftBucket(r.horario) === recActiveShift);
  recCurrentFiltered = recGlobalReassignedView
    ? baseRows.filter(r => recIsPendingReassigned(r.id_in_cc))
    : (recOnlyReassigned ? shiftRows.filter(r => recIsPendingReassigned(r.id_in_cc)) : shiftRows);

  const active = recFiltersActive();
  document.getElementById('rec-clear-btn').style.display = active ? 'flex' : 'none';
  const sw = document.querySelector('#view-recalls .gd-search-wrap');
  if (sw) sw.classList.toggle('active', !!document.getElementById('rec-search').value.trim());
  ['rec-f-tl', 'rec-f-country', 'rec-f-substatus', 'rec-f-color'].forEach(id => {
    document.getElementById(id).classList.toggle('rec-f-on', !!document.getElementById(id).value);
  });

  renderRecShiftTabs(baseRows);
  renderRecReassignToggles(baseRows, shiftRows);
  recRenderKPIs();
  renderRecTree();
  if (recToolOpen === 'load') recRenderLoadTool();
}

/* ══════════════════════════════
   INDICADORES
══════════════════════════════ */
function recRenderKPIs() {
  const scoped = recScopeRows(recCurrentRows);
  const shiftCounts = REC_SHIFTS.map(s => `${s === 'Post-Sale' ? 'PS' : s === 'Nocturno' ? 'Noc' : s} ${scoped.filter(r => recShiftBucket(r.horario) === s).length}`).join(' · ');
  const pending = scoped.filter(r => recIsPendingReassigned(r.id_in_cc));
  const oldest = pending.map(r => recAlertIndex[r.id_in_cc].detected_at).filter(Boolean).sort()[0];
  const ids = new Set(scoped.map(r => r.id_in_cc));
  const reviewedToday = recAlertRows.filter(a => a.reviewed && a.reviewed_at && repIsToday(a.reviewed_at) && ids.has(a.id_in_cc));
  const reviewers = [...new Set(reviewedToday.map(a => a.reviewed_by).filter(Boolean))];
  const yellow = scoped.filter(r => recColorGroup(r) === 'yellow').length;
  const red = scoped.filter(r => recColorGroup(r) === 'red').length;
  const colorNow = document.getElementById('rec-f-color').value;
  const cards = [
    { icon: '📦', label: 'Órdenes', value: scoped.length, sub: shiftCounts, tone: 'neutral', on: false, click: '' },
    { icon: '🔴', label: 'Reasignadas pendientes', value: pending.length, sub: pending.length ? `la más antigua ${repTimeAgo(oldest)}` : '✓ ninguna sin revisar', tone: pending.length ? 'bad' : 'good', on: recGlobalReassignedView, click: 'recKpiPending()' },
    { icon: '✅', label: 'Revisadas hoy', value: reviewedToday.length, sub: reviewers.length ? `por ${reviewers.slice(0, 2).join(', ')}${reviewers.length > 2 ? ` y ${reviewers.length - 2} más` : ''}` : 'nadie todavía', tone: 'neutral', on: false, click: '' },
    { icon: '🟡', label: 'Amarillas', value: yellow, sub: 'No answer (Comparar Status)', tone: yellow ? 'warn' : 'neutral', on: colorNow === 'yellow', click: "recKpiColor('yellow')" },
    { icon: '🟥', label: 'Rojas', value: red, sub: 'Approved / Reject / Trash', tone: red ? 'bad' : 'neutral', on: colorNow === 'red', click: "recKpiColor('red')" },
  ];
  const el = document.getElementById('rec-kpis');
  el.style.setProperty('--n', cards.length);
  el.innerHTML = cards.map(c => c.click
    ? `<button type="button" class="dash-kpi dash-kpi--${c.tone} rec-kpi ${c.on ? 'is-on' : ''}" onclick="${c.click}" aria-pressed="${c.on}">
        <span class="dash-kpi-head"><span class="dash-kpi-icon">${c.icon}</span><span class="dash-kpi-label">${c.label}</span></span>
        <span class="dash-kpi-row"><span class="dash-kpi-value">${c.value.toLocaleString('es-PE')}</span></span>
        <span class="dash-kpi-sub">${escapeHtml(c.sub)}</span></button>`
    : `<div class="dash-kpi dash-kpi--${c.tone} rec-kpi rec-kpi--static">
        <span class="dash-kpi-head"><span class="dash-kpi-icon">${c.icon}</span><span class="dash-kpi-label">${c.label}</span></span>
        <span class="dash-kpi-row"><span class="dash-kpi-value">${c.value.toLocaleString('es-PE')}</span></span>
        <span class="dash-kpi-sub">${escapeHtml(c.sub)}</span></div>`).join('');
}

function recKpiPending() {
  recGlobalReassignedView = !recGlobalReassignedView;
  if (recGlobalReassignedView) recOnlyReassigned = false;
  applyRecFilters();
}
function recKpiColor(color) {
  const sel = document.getElementById('rec-f-color');
  sel.value = sel.value === color ? '' : color;
  applyRecFilters();
}

/* ══════════════════════════════
   HERRAMIENTAS — historial, carga por operador, excluidas, Comparar Status
══════════════════════════════ */
let recToolOpen = null;

function recRenderTools() {
  const tools = [
    ['history', `📜 Historial de cargas`],
    ['load', '📊 Carga por operador'],
    ...(can('recalls.compare') ? [['excluded', `🚫 Excluidas (${recExcludedRows.length})`], ['status', '🎨 Comparar Status']] : []),
  ];
  document.getElementById('rec-tools-seg').innerHTML = tools.map(([k, l]) =>
    `<button type="button" class="eq-seg-btn ${recToolOpen === k ? 'active' : ''}" onclick="recToggleTool('${k}')">${l}</button>`).join('');
  ['history', 'load', 'excluded', 'status'].forEach(k => { document.getElementById(`rec-tool-${k}`).hidden = recToolOpen !== k; });
  if (recToolOpen === 'history') recRenderHistoryTool();
  if (recToolOpen === 'load') recRenderLoadTool();
  if (recToolOpen === 'excluded') recRenderExcludedTool();
}

function recToggleTool(k) {
  recToolOpen = recToolOpen === k ? null : k;
  recRenderTools();
}

function recRenderHistoryTool() {
  const box = document.getElementById('rec-tool-history');
  if (recUploads === null) { box.innerHTML = '<div class="rec-tool-empty">El historial de cargas empieza a guardarse después de correr el script 12 en Supabase.</div>'; return; }
  if (!recUploads.length) { box.innerHTML = '<div class="rec-tool-empty">Todavía no hay cargas registradas. La próxima vez que se suba el Excel aparecerá aquí.</div>'; return; }
  box.innerHTML = `<div class="tbl-wrap"><table class="rec-hist">
    <thead><tr><th>Fecha</th><th>Subido por</th><th>Archivo</th><th class="num">Cargadas</th><th class="num">Nuevas</th><th class="num">Salieron</th><th class="num">Reasignadas</th><th class="num">Excluidas</th></tr></thead>
    <tbody>${recUploads.map(u => `<tr>
      <td class="nowrap">${escapeHtml(repFmtDateTime(u.subido_at))} <span class="muted-11">${escapeHtml(repTimeAgo(u.subido_at))}</span></td>
      <td class="nowrap">${escapeHtml(u.subido_por || '—')}</td>
      <td class="rec-hist-file" title="${escapeHtml(u.archivo || '')}">${escapeHtml(u.archivo || '—')}</td>
      <td class="num"><strong>${u.total}</strong></td>
      <td class="num txt-ok">+${u.nuevas}</td>
      <td class="num">${u.salieron ? `−${u.salieron}` : '0'}</td>
      <td class="num">${u.reasignadas ? `<span class="rec-reassigned-badge">🔴 ${u.reasignadas}</span>` : '0'}</td>
      <td class="num">${u.excluidas || 0}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

/* Recalls por operador en lo que se está viendo (turno + filtros): quién está más cargado */
function recRenderLoadTool() {
  const box = document.getElementById('rec-tool-load');
  const byOp = new Map();
  recCurrentFiltered.forEach(r => {
    const k = r.last_call_operator || '—';
    const o = byOp.get(k) || { op: k, asesor: r.asesor || '—', tl: r.team_leader || '—', n: 0, pending: 0 };
    o.n++;
    if (recIsPendingReassigned(r.id_in_cc)) o.pending++;
    byOp.set(k, o);
  });
  const list = [...byOp.values()].sort((a, b) => b.n - a.n);
  if (!list.length) { box.innerHTML = '<div class="rec-tool-empty">No hay órdenes con los filtros actuales.</div>'; return; }
  const avg = list.reduce((s, o) => s + o.n, 0) / list.length;
  const max = list[0].n;
  const scope = recGlobalReassignedView ? 'reasignadas pendientes, todos los turnos' : `turno ${recActiveShift}`;
  box.innerHTML = `<div class="rec-load-head">${list.length} operadores · ${scope} · promedio <strong>${avg.toFixed(1)}</strong> recalls por OP ·
      <span class="rec-load-hi">alto</span> = 50% más que el promedio</div>
    <div class="rec-load">${list.map(o => {
      const high = list.length > 2 && o.n >= avg * 1.5;
      return `<div class="rec-load-row ${high ? 'is-high' : ''}">
        <span class="rec-load-name" title="${escapeHtml(o.asesor)} · ${escapeHtml(o.op)}">${escapeHtml(o.asesor)}</span>
        <span class="rec-load-tl">${recTlBadge(o.tl)}</span>
        <span class="rec-load-bar"><i style="width:${((o.n / max) * 100).toFixed(1)}%"></i><b style="left:${((avg / max) * 100).toFixed(1)}%" title="Promedio"></b></span>
        <span class="rec-load-n">${o.n}${o.pending ? ` <span class="rec-load-p" title="Reasignadas sin revisar">🔴${o.pending}</span>` : ''}</span>
      </div>`;
    }).join('')}</div>`;
}

/* Excluidas: órdenes que no se vuelven a cargar (se eliminaron por color). Se pueden restaurar. */
function recRenderExcludedTool() {
  const box = document.getElementById('rec-tool-excluded');
  if (!recExcludedRows.length) { box.innerHTML = '<div class="rec-tool-empty">No hay órdenes excluidas.</div>'; return; }
  const when = r => r.created_at || r.excluded_at || r.inserted_at || null;
  box.innerHTML = `<div class="rec-excl-head">
      <span>${recExcludedRows.length} orden(es) excluida(s): no se cargan aunque vengan en el Excel. Al restaurarlas vuelven a aparecer con la <strong>próxima carga</strong> (si vienen en ella).</span>
      <button type="button" class="btn btn-ghost btn-sm" onclick="recRestoreExcluded(null)">↩ Restaurar todas</button>
    </div>
    <div class="rec-excl-list">${recExcludedRows.map(r => `<div class="rec-excl-item">
      <span class="rec-swatch ${r.reason === 'red' ? 'rec-swatch--red' : r.reason === 'yellow' ? 'rec-swatch--yellow' : ''}"></span>
      <strong>${escapeHtml(r.id_in_cc)}</strong>
      ${when(r) ? `<span class="muted-11">${escapeHtml(repFmtDateTime(when(r)))}</span>` : ''}
      <button type="button" class="btn btn-ghost btn-sm" onclick="recRestoreExcluded(${jsArg(r.id_in_cc)})" title="Restaurar">↩</button>
    </div>`).join('')}</div>`;
}

async function recRestoreExcluded(id) {
  if (!can('recalls.compare')) return;
  const ids = id ? [id] : recExcludedRows.map(r => r.id_in_cc);
  if (!ids.length) return;
  if (!id) {
    const ok = await uiConfirm(`Se restaurarán ${ids.length} orden(es) excluida(s). Volverán a aparecer con la próxima carga del Excel, si vienen en él.`, { title: '¿Restaurar todas?', confirmText: 'Restaurar' });
    if (!ok) return;
  }
  try {
    for (let i = 0; i < ids.length; i += REC_ID_BATCH) {
      const idsParam = ids.slice(i, i + REC_ID_BATCH).map(x => encodeURIComponent(x)).join(',');
      const res = await fetch(`${SB_URL}/rest/v1/dt_recalls_excluded?id_in_cc=in.(${idsParam})`, { method: 'DELETE', headers: SB_HEADERS });
      if (!res.ok) throw new Error(`No se pudo restaurar (${await acctErrorDetail(res)})`);
    }
    await recLoadAll(true);
  } catch (err) {
    console.error('Error restaurando excluidas:', err);
    uiAlert(err.message || 'No se pudo restaurar, intenta de nuevo.', { title: 'Error', tone: 'danger' });
  }
}

/* ══════════════════════════════
   PIEZAS VISUALES COMPARTIDAS (las usan otras secciones)
══════════════════════════════ */
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
  if (!v || v === '—') return '<span class="txt-light">—</span>';
  const c = recColorForName(v);
  return `<span class="pill-badge pill-badge--tl" style="--bg:${c.bg};--fg:${c.color}">${escapeHtml(v)}</span>`;
}

/* Una sola columna "Enlaces": un botón que abre un menú con Change / View */
function recLinkCells(idInCc) {
  if (!idInCc) return '<td></td>';
  return `
    <td class="rec-links-td">
      <button class="btn btn-ghost btn-sm rec-link-trigger rec-links-btn" title="Abrir Change / View" aria-label="Abrir Change / View" onclick="recOpenLinkMenu(event,${jsArg(idInCc)})">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
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

/* Antes en gris, ahora en rojo */
function recArrowHTML(oldVal, newVal) {
  return `<div class="rec-arrow">
    <span class="rec-arrow-old">${escapeHtml(oldVal) || '—'}</span>
    <span class="rec-arrow-new">${escapeHtml(newVal) || '—'}</span>
  </div>`;
}

/* ══════════════════════════════
   ÁRBOL — Team Leader > Operador > Órdenes
══════════════════════════════ */
const REC_OPEN_KEY = 'gc_rec_open';
let recExpandedTLs = new Set();
let recExpandedOps = new Set();

function recRestoreExpanded() {
  try {
    const v = JSON.parse(localStorage.getItem(REC_OPEN_KEY) || '{}');
    recExpandedTLs = new Set(Array.isArray(v.tls) ? v.tls : []);
    recExpandedOps = new Set(Array.isArray(v.ops) ? v.ops : []);
  } catch { /* sin storage: arranca todo cerrado */ }
}
function recSaveExpanded() {
  try { localStorage.setItem(REC_OPEN_KEY, JSON.stringify({ tls: [...recExpandedTLs], ops: [...recExpandedOps] })); } catch { /* nada */ }
}

/* Anima un contenedor deslizando su alto real (scrollHeight) */
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
  recSaveExpanded();
  recAnimateCollapse(document.getElementById(`rec-tlbody-${ti}`), opening);
  document.getElementById(`rec-tlchevron-${ti}`)?.classList.toggle('rec-tree-open', opening);
}

function recToggleOp(ti, oi, opKey) {
  const opEl = document.getElementById(`rec-opbody-${ti}-${oi}`);
  const opening = !recExpandedOps.has(opKey);
  // El alto destino del Team Leader se calcula ANTES de togglear al operador y se aplica junto con él:
  // así las dos animaciones corren a la par y el TL nunca queda con un tope viejo cortando al operador.
  const tlBody = document.getElementById(`rec-tlbody-${ti}`);
  let tlTarget = null;
  if (tlBody && tlBody.style.maxHeight && tlBody.style.maxHeight !== '0px' && opEl) {
    const delta = opening ? opEl.scrollHeight : -opEl.scrollHeight;
    tlTarget = Math.max(0, tlBody.scrollHeight + delta);
  }
  opening ? recExpandedOps.add(opKey) : recExpandedOps.delete(opKey);
  recSaveExpanded();
  recAnimateCollapse(opEl, opening);
  document.getElementById(`rec-opchevron-${ti}-${oi}`)?.classList.toggle('rec-tree-open', opening);
  if (tlTarget !== null) tlBody.style.maxHeight = tlTarget + 'px';
}

/* Abrir / cerrar todo lo que se está viendo */
function recExpandAll(open) {
  if (recGlobalReassignedView) return;   // la vista global ya es una tabla plana
  const tree = recBuildTree(recCurrentFiltered);
  tree.forEach(tl => {
    open ? recExpandedTLs.add(tl.teamLeader) : recExpandedTLs.delete(tl.teamLeader);
    tl.operators.forEach(op => {
      const k = `${tl.teamLeader}::${op.operator}`;
      open ? recExpandedOps.add(k) : recExpandedOps.delete(k);
    });
  });
  recSaveExpanded();
  renderRecTree();
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

/* Órdenes visibles de un Team Leader o de un Operador (para copiar y para "revisar todas") */
function recRowsOf(kind, tlKey, opKey) {
  return recCurrentFiltered.filter(r => (r.team_leader || '—') === tlKey && (kind === 'tl' || (r.last_call_operator || '—') === opKey));
}

const REC_EMPTY_TEXT_DEFAULT = { p: 'Sin órdenes para este turno / filtro', small: 'Prueba con otro turno o quita los filtros activos' };
const REC_EMPTY_TEXT_GLOBAL  = { p: 'No hay reasignaciones pendientes', small: 'Todas las órdenes reasignadas ya fueron revisadas, en todos los turnos.' };
function recSetEmptyText(texts) {
  const empty = document.getElementById('rec-empty');
  empty.querySelector('p').textContent = texts.p;
  empty.querySelector('small').textContent = texts.small;
}

function renderRecTree() {
  document.getElementById('rec-loading').style.display = 'none';
  document.getElementById('rec-showing').textContent = recCurrentFiltered.length;
  document.getElementById('rec-total').textContent = recScopeRows(recCurrentRows).length;
  const wrap = document.getElementById('rec-tree');
  const empty = document.getElementById('rec-empty');

  if (recGlobalReassignedView) {
    if (recCurrentFiltered.length === 0) { wrap.innerHTML = ''; recSetEmptyText(REC_EMPTY_TEXT_GLOBAL); empty.style.display = 'flex'; return; }
    empty.style.display = 'none';
    wrap.innerHTML = recRenderGlobalReassignedTable(recCurrentFiltered);
    return;
  }

  recSetEmptyText(REC_EMPTY_TEXT_DEFAULT);
  const tlGroups = recBuildTree(recCurrentFiltered);
  if (tlGroups.length === 0) { wrap.innerHTML = ''; empty.style.display = 'flex'; return; }
  empty.style.display = 'none';

  const canReview = can('recalls.review');
  // El contenido se genera siempre (aunque esté cerrado) para poder medir su alto real y animarlo
  wrap.innerHTML = tlGroups.map((tl, ti) => {
    const tlKey = tl.teamLeader;
    const expanded = recExpandedTLs.has(tlKey);
    const tlArg = jsArg(tlKey);
    return `
    <div class="panel rec-tree-panel">
      <div class="rec-tl-header" onclick="recToggleTL(${ti},${tlArg})">
        <svg class="rec-tree-chevron ${expanded ? 'rec-tree-open' : ''}" id="rec-tlchevron-${ti}" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
        ${recTlBadge(tl.teamLeader)}
        <span class="rec-muted-12">${tl.total} ${tl.total === 1 ? 'orden' : 'órdenes'} · ${tl.operators.length} OP${tl.operators.length === 1 ? '' : 's'}</span>
        ${tl.reassignedCount > 0 ? `<span class="rec-reassigned-badge">🔴 ${tl.reassignedCount} reasignada${tl.reassignedCount === 1 ? '' : 's'}</span>` : ''}
        <span class="rec-head-actions" onclick="event.stopPropagation()">
          ${canReview && tl.reassignedCount ? `<button type="button" class="btn btn-ghost btn-sm" onclick="recMarkGroupReviewed('tl',${tlArg})" title="Marcar revisadas todas las reasignadas de este equipo">✓ Revisar ${tl.reassignedCount}</button>` : ''}
          <button type="button" class="btn btn-ghost btn-sm" onclick="recCopyMessage('tl',${tlArg})" title="Copiar un mensaje con todas las órdenes de este equipo (para WhatsApp)">📋 Copiar</button>
        </span>
      </div>
      <div class="rec-tl-collapse" id="rec-tlbody-${ti}" data-expanded="${expanded ? '1' : '0'}">
        <div class="rec-tl-body">${tl.operators.map((op, oi) => recRenderOperatorBlock(ti, oi, tlKey, op, canReview)).join('')}</div>
      </div>
    </div>`;
  }).join('');

  // Fixup en dos pasadas: primero operadores (más profundo), luego Team Leaders
  document.querySelectorAll('#rec-tree .rec-op-collapse').forEach(el => { if (el.dataset.expanded === '1') el.style.maxHeight = el.scrollHeight + 'px'; });
  document.querySelectorAll('#rec-tree .rec-tl-collapse').forEach(el => { if (el.dataset.expanded === '1') el.style.maxHeight = el.scrollHeight + 'px'; });
}

function recRenderOperatorBlock(ti, oi, tlKey, op, canReview) {
  const opKey = `${tlKey}::${op.operator}`;
  const expanded = recExpandedOps.has(opKey);
  const args = `${jsArg(tlKey)},${jsArg(op.operator)}`;
  return `
  <div class="rec-op-block">
    <div class="rec-op-header" onclick="recToggleOp(${ti},${oi},${jsArg(opKey)})">
      <svg class="rec-tree-chevron sm ${expanded ? 'rec-tree-open' : ''}" id="rec-opchevron-${ti}-${oi}" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>
      <span class="rec-op-name">${escapeHtml(op.asesor)}</span>
      <span class="rec-muted-10">${escapeHtml(op.operator)}</span>
      <span class="rec-muted-11">${op.rows.length} ${op.rows.length === 1 ? 'orden' : 'órdenes'}</span>
      ${op.reassignedCount > 0 ? `<span class="rec-reassigned-badge">🔴 ${op.reassignedCount}</span>` : ''}
      <span class="rec-head-actions" onclick="event.stopPropagation()">
        ${canReview && op.reassignedCount ? `<button type="button" class="btn btn-ghost btn-sm" onclick="recMarkGroupReviewed('op',${args})" title="Marcar revisadas sus reasignadas">✓ Revisar ${op.reassignedCount}</button>` : ''}
        <button type="button" class="btn btn-ghost btn-sm" onclick="recCopyMessage('op',${args})" title="Copiar un mensaje con todas sus órdenes (para WhatsApp)">📋 Copiar</button>
      </span>
    </div>
    <div class="rec-op-collapse" id="rec-opbody-${ti}-${oi}" data-expanded="${expanded ? '1' : '0'}">
      ${recRenderOperatorRowsTable(op.rows)}
    </div>
  </div>`;
}

/* Celda de reasignación: de quién a quién, cuándo, quién la revisó, y la cadena si hubo varias */
function recReassignCell(r) {
  const a = r._alert;
  if (!a) return '<span class="rec-muted-11">—</span>';
  const chain = recAlertChain[r.id_in_cc] || [a];
  const chainTip = chain.slice().reverse().map(x => `${x.detected_at ? repFmtDateTime(x.detected_at) : '—'}: ${x.old_asesor || x.old_operator || '—'} → ${x.new_asesor || x.new_operator || '—'}${x.reviewed ? ' (revisada)' : ''}`).join('\n');
  const action = a.reviewed
    ? `<span class="badge badge-green" title="${escapeHtml(`Revisada${a.reviewed_by ? ` por ${a.reviewed_by}` : ''}${a.reviewed_at ? ` el ${repFmtDateTime(a.reviewed_at)}` : ''}`)}">✓ ${escapeHtml(a.reviewed_by ? a.reviewed_by.split(' ')[0] : 'Revisado')}${a.reviewed_at ? ` · ${escapeHtml(repTimeAgo(a.reviewed_at))}` : ''}</span>`
    : (can('recalls.review') ? `<button class="btn btn-ghost btn-sm" onclick="recMarkReviewed(${jsArg(a.id)})">Marcar revisado</button>` : `<span class="badge badge-red">Pendiente</span>`);
  return `<div class="rec-reassign">
    ${recArrowHTML(a.old_asesor && a.old_asesor !== '—' ? a.old_asesor : a.old_operator, r.asesor && r.asesor !== '—' ? r.asesor : r.last_call_operator)}
    <div class="rec-reassign-meta">
      ${a.detected_at ? `<span class="rec-muted-10" title="${escapeHtml(repFmtDateTime(a.detected_at))}">${escapeHtml(repTimeAgo(a.detected_at))}</span>` : ''}
      ${chain.length > 1 ? `<span class="rec-chain" title="${escapeHtml(chainTip)}">×${chain.length} reasignaciones</span>` : ''}
      ${action}
    </div>
  </div>`;
}

function recRenderOperatorRowsTable(rows) {
  return `<div class="tbl-wrap"><table>
    <thead><tr>
      <th>Id in CC</th><th>Country</th><th>Substatus</th><th>CC comment</th><th>Horario</th><th>Reasignación</th>
      <th class="rec-links-th">Enlaces</th>
    </tr></thead>
    <tbody>${rows.map(r => `<tr class="${recStatusColorClass(r.status_check)} ${r._pending ? 'rec-reassigned-row' : ''}">
        <td><strong>${escapeHtml(r.id_in_cc) || '—'}</strong></td>
        <td>${countryFlag(r.country)}${escapeHtml(r.country) || '—'}</td>
        <td>${escapeHtml(r.substatus) || '—'}</td>
        <td class="rec-comment">${escapeHtml(r.cc_comment) || '—'}</td>
        <td>${gdScheduleBadge(r.horario)}</td>
        <td class="nowrap">${recReassignCell(r)}</td>
        ${recLinkCells(r.id_in_cc)}
      </tr>`).join('')}</tbody>
  </table></div>`;
}

/* Vista global "Todas las reasignadas": una sola tabla plana, ordenada Team Leader > Operador > Id in CC */
function recRenderGlobalReassignedTable(rows) {
  const sorted = [...rows].sort((a, b) =>
    (a.team_leader || '—').localeCompare(b.team_leader || '—') || (a.asesor || '—').localeCompare(b.asesor || '—') || (a.id_in_cc || '').localeCompare(b.id_in_cc || ''));
  return `<div class="tbl-wrap"><table>
    <thead><tr>
      <th>Team Leader</th><th>Operador</th><th>Turno</th><th>Id in CC</th><th>Country</th><th>Substatus</th><th>CC comment</th><th>Horario</th><th>Reasignación</th>
      <th class="rec-links-th">Enlaces</th>
    </tr></thead>
    <tbody>${sorted.map(r => {
      const augmented = { ...r, _alert: recAlertIndex[r.id_in_cc] || null };
      return `<tr class="${recStatusColorClass(r.status_check)} rec-reassigned-row">
        <td>${recTlBadge(r.team_leader)}</td>
        <td class="nowrap"><span class="rec-op-name">${escapeHtml(r.asesor) || '—'}</span> <span class="rec-muted-10">${escapeHtml(r.last_call_operator) || '—'}</span></td>
        <td class="nowrap rec-muted-11">${recShiftBucket(r.horario) || '—'}</td>
        <td><strong>${escapeHtml(r.id_in_cc) || '—'}</strong></td>
        <td>${countryFlag(r.country)}${escapeHtml(r.country) || '—'}</td>
        <td>${escapeHtml(r.substatus) || '—'}</td>
        <td class="rec-comment">${escapeHtml(r.cc_comment) || '—'}</td>
        <td>${gdScheduleBadge(r.horario)}</td>
        <td class="nowrap">${recReassignCell(augmented)}</td>
        ${recLinkCells(r.id_in_cc)}
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

/* ══════════════════════════════
   COPIAR — mensaje listo por Team Leader u Operador (estilo ficha de Equipos 360)
══════════════════════════════ */
function recScopeLabel() {
  const parts = [recGlobalReassignedView ? 'Reasignadas pendientes (todos los turnos)' : `Turno ${recActiveShift}`];
  if (!recGlobalReassignedView && recOnlyReassigned) parts.push('solo reasignadas');
  const f = [['rec-f-country', 'País'], ['rec-f-substatus', 'Substatus']].map(([id, l]) => document.getElementById(id).value ? `${l}: ${document.getElementById(id).value}` : '').filter(Boolean);
  const color = document.getElementById('rec-f-color').value;
  if (color) f.push({ yellow: 'solo amarillas', red: 'solo rojas', none: 'sin color' }[color]);
  if (document.getElementById('rec-search').value.trim()) f.push(`búsqueda "${document.getElementById('rec-search').value.trim()}"`);
  return parts.concat(f).join(' · ');
}

function recNowStamp() {
  const d = new Date();
  return `${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}

function recCopyMessage(kind, tlKey, opKey) {
  const rows = recRowsOf(kind, tlKey, opKey);
  if (!rows.length) return;
  const pend = rows.filter(r => recIsPendingReassigned(r.id_in_cc)).length;
  const idLine = r => `${r.id_in_cc}${recIsPendingReassigned(r.id_in_cc) ? ' 🔴' : ''}`;
  const lines = [];
  if (kind === 'op') {
    const o = rows[0];
    lines.push(`🔁 RECALLS — ${(o.asesor && o.asesor !== '—' ? o.asesor : o.last_call_operator).toUpperCase()} (${o.last_call_operator})`);
    lines.push(`👤 Team Leader: ${tlKey}`);
    lines.push(`🗓 ${recScopeLabel()} · al ${recNowStamp()}`);
    lines.push('');
    lines.push(`📦 Total: ${rows.length} ${rows.length === 1 ? 'orden' : 'órdenes'}${pend ? ` · 🔴 ${pend} reasignada${pend === 1 ? '' : 's'} sin revisar` : ''}`);
    lines.push('🆔 IDs:');
    rows.forEach(r => lines.push(idLine(r)));
  } else {
    const byOp = new Map();
    rows.forEach(r => { const k = r.last_call_operator || '—'; if (!byOp.has(k)) byOp.set(k, []); byOp.get(k).push(r); });
    const ops = [...byOp.values()].sort((a, b) => b.length - a.length || (a[0].asesor || '').localeCompare(b[0].asesor || ''));
    lines.push(`🔁 RECALLS DEL EQUIPO — ${tlKey.toUpperCase()}`);
    lines.push(`🗓 ${recScopeLabel()} · al ${recNowStamp()}`);
    lines.push(`📦 ${rows.length} ${rows.length === 1 ? 'orden' : 'órdenes'} · ${ops.length} OP${ops.length === 1 ? '' : 's'}${pend ? ` · 🔴 ${pend} reasignada${pend === 1 ? '' : 's'} sin revisar` : ''}`);
    ops.forEach(list => {
      const o = list[0];
      lines.push('');
      lines.push(`👤 ${(o.asesor && o.asesor !== '—' ? o.asesor : o.last_call_operator).toUpperCase()} (${o.last_call_operator}) — ${list.length}`);
      lines.push(list.map(idLine).join(', '));
    });
  }
  if (pend) { lines.push(''); lines.push('🔴 = orden reasignada a este operador, pendiente de revisar'); }
  recCopyText(lines.join('\n')).then(ok => recToast(ok
    ? `✓ Copiado: ${rows.length} ${rows.length === 1 ? 'orden' : 'órdenes'} de ${kind === 'op' ? (rows[0].asesor || opKey) : `el equipo de ${tlKey}`} — pégalo en WhatsApp`
    : 'No se pudo copiar al portapapeles.', !ok));
}

async function recCopyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (err) {
    console.error('Error copiando al portapapeles:', err);
    return false;
  }
}

/* Aviso flotante breve (abajo a la derecha) */
let recToastTimer = null;
function recToast(text, isError = false) {
  let el = document.getElementById('rec-toast');
  if (!el) { el = uiEl('div', 'rec-toast'); el.id = 'rec-toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
  el.textContent = text;
  el.classList.toggle('is-error', isError);
  el.classList.add('show');
  clearTimeout(recToastTimer);
  recToastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

/* ── Copiar Id in CC visibles en grupos de REC_COPY_CHUNK_SIZE (el sistema externo no acepta bloques grandes) ── */
const REC_COPY_CHUNK_SIZE = 150;
const REC_COPY_ORDINALS = ['primeros', 'segundos', 'terceros', 'cuartos', 'quintos', 'sextos', 'séptimos', 'octavos', 'novenos', 'décimos'];

function recToggleCopyMenu(evt) {
  evt.stopPropagation();
  const menu = document.getElementById('rec-copy-menu');
  const opening = menu.style.display === 'none';
  if (opening) recRenderCopyMenu();
  menu.style.display = opening ? 'block' : 'none';
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('rec-copy-menu');
  if (!menu || menu.style.display === 'none') return;
  if (!menu.contains(e.target) && !e.target.closest('#rec-copy-ids-btn')) menu.style.display = 'none';
});

function recRenderCopyMenu() {
  const menu = document.getElementById('rec-copy-menu');
  const total = recCurrentFiltered.filter(r => r.id_in_cc).length;
  if (total === 0) { menu.innerHTML = `<div class="rec-copy-menu-item rec-copy-empty">No hay IDs para copiar</div>`; return; }
  let items = '';
  for (let start = 0; start < total; start += REC_COPY_CHUNK_SIZE) {
    const end = Math.min(start + REC_COPY_CHUNK_SIZE, total);
    const groupIdx = start / REC_COPY_CHUNK_SIZE;
    const label = REC_COPY_ORDINALS[groupIdx] || `grupo ${groupIdx + 1}`;
    items += `<div class="rec-copy-menu-item" onclick="recCopyIdsChunk(${start},${end})">
      <span>Copiar ${label} ${end - start} IDs</span><span class="rec-copy-menu-range">${start + 1}–${end}</span></div>`;
  }
  if (total > REC_COPY_CHUNK_SIZE) items += `<div class="rec-copy-menu-item all" onclick="recCopyIdsChunk(0,${total})"><span>Copiar todos (${total})</span></div>`;
  menu.innerHTML = items;
}

async function recCopyIdsChunk(start, end) {
  const ids = recCurrentFiltered.map(r => r.id_in_cc).filter(Boolean).slice(start, end);
  document.getElementById('rec-copy-menu').style.display = 'none';
  if (!ids.length) return;
  const ok = await recCopyText(ids.join(' '));
  recToast(ok ? `✓ ${ids.length} IDs copiados` : 'No se pudo copiar al portapapeles.', !ok);
}

/* ══════════════════════════════
   COMPARAR STATUS — pega una exportación con columnas "#" (Id in CC) y "Status"
══════════════════════════════ */
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

/* Rojo/Amarillo/sin color según el Status (lo usa también Stats OPs Today) */
function recStatusColorClass(statusCheck) {
  const s = (statusCheck || '').trim().toLowerCase();
  if (!s || s === 'recall') return '';
  if (s === 'no answer') return 'rec-status-yellow';
  if (s === 'reject' || s === 'approved' || s === 'trash') return 'rec-status-red';
  return '';
}

/* Cuántos Id in CC van en cada pedido "in.(…)" — la URL tiene un largo máximo */
const REC_ID_BATCH = 150;

async function recPatchStatusCheck(table, ids, statusValue, label) {
  for (let i = 0; i < ids.length; i += REC_ID_BATCH) {
    const idsParam = ids.slice(i, i + REC_ID_BATCH).map(id => encodeURIComponent(id)).join(',');
    const res = await fetch(`${SB_URL}/rest/v1/${table}?id_in_cc=in.(${idsParam})`, {
      method: 'PATCH',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ status_check: statusValue }),
    });
    if (!res.ok) throw new Error(`Supabase update error${label} ${await acctErrorDetail(res)}`);
  }
}

async function recCompareStatus() {
  if (!can('recalls.compare')) return;
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
  const groupByStatus = arr => { const m = {}; arr.forEach(x => { (m[x.status || ''] = m[x.status || ''] || []).push(x.id); }); return m; };
  try {
    for (const [statusValue, ids] of Object.entries(groupByStatus(mainMatches))) await recPatchStatusCheck('dt_recalls', ids, statusValue, '');
    for (const [statusValue, ids] of Object.entries(groupByStatus(alertMatches))) await recPatchStatusCheck('dt_recalls_alerts', ids, statusValue, ' (alertas)');
    await recLoadAll(true);
    statusEl.style.color = 'var(--green)';
    statusEl.textContent = `✓ ${totalMatched} orden(es) actualizadas`;
    document.getElementById('rec-status-raw-input').value = '';
    setTimeout(() => { statusEl.textContent = ''; }, 6000);
  } catch (err) {
    console.error('Error comparando status:', err);
    statusEl.style.color = 'var(--red)';
    statusEl.textContent = (err && err.message) ? err.message : 'Error al actualizar, intenta de nuevo.';
  }
}

/* ── Eliminar por color + exclusión (no se vuelven a cargar; se pueden restaurar en "Excluidas") ── */
function recColorGroup(row) {
  const cls = recStatusColorClass(row.status_check);
  if (cls === 'rec-status-yellow') return 'yellow';
  if (cls === 'rec-status-red') return 'red';
  return null;
}

async function recDeleteByStatusColor(color) {
  if (!can('recalls.compare')) return;
  const ids = recCurrentRows.filter(r => recColorGroup(r) === color).map(r => r.id_in_cc);
  if (ids.length === 0) return;
  const label = color === 'yellow' ? 'amarillas' : 'rojas';
  const ok = await uiConfirm(`Se eliminarán ${ids.length} orden(es) marcadas en ${label}. No se van a volver a cargar aunque aparezcan en un Excel futuro (se pueden restaurar en "Excluidas").`, {
    title: `¿Eliminar órdenes ${label}?`, confirmText: 'Eliminar', danger: true,
  });
  if (!ok) return;
  // Primero se guarda la exclusión y SOLO si se guardó se borran las órdenes (si no, volverían con el próximo Excel)
  let deleted = 0;
  try {
    for (let i = 0; i < ids.length; i += REC_ID_BATCH) {
      const batch = ids.slice(i, i + REC_ID_BATCH);
      const exRes = await fetch(`${SB_URL}/rest/v1/dt_recalls_excluded?on_conflict=id_in_cc`, {
        method: 'POST',
        headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(batch.map(id => ({ id_in_cc: id, reason: color }))),
      });
      if (!exRes.ok) throw new Error(`No se pudo guardar la exclusión (${await acctErrorDetail(exRes)})`);
      const idsParam = batch.map(id => encodeURIComponent(id)).join(',');
      const res = await fetch(`${SB_URL}/rest/v1/dt_recalls?id_in_cc=in.(${idsParam})`, { method: 'DELETE', headers: SB_HEADERS });
      if (!res.ok) throw new Error(`No se pudieron borrar las órdenes (${await acctErrorDetail(res)})`);
      deleted += batch.length;
    }
    await recLoadAll();
  } catch (err) {
    console.error('Error eliminando órdenes por color:', err);
    await recLoadAll();
    uiAlert(`${deleted ? `Se eliminaron ${deleted} de ${ids.length} órdenes, pero el resto falló. ` : 'No se eliminó ninguna orden. '}${err.message || ''}`,
      { title: 'No se pudo completar', tone: 'danger' });
  }
}

/* Caja azul: quién y cuándo hizo la última carga */
function recRenderLastUpdate() {
  const box = document.getElementById('rec-lastupd-box');
  const first = recCurrentRows[0];
  if (!first || !first.uploaded_by) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  document.getElementById('rec-lastupd-name').textContent = first.uploaded_by;
  const t = first.uploaded_at ? new Date(first.uploaded_at) : null;
  document.getElementById('rec-lastupd-time').textContent = t
    ? `${t.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })} · ${t.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} (${repTimeAgo(first.uploaded_at)})`
    : '';
}

/* Números de los botones de eliminar (antes de presionarlos) */
function recUpdateDeleteCounts() {
  const cnt = color => recCurrentRows.filter(r => recColorGroup(r) === color).length;
  const setTxt = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
  setTxt('rec-del-yellow', `Eliminar amarillas (${cnt('yellow')})`);
  setTxt('rec-del-red', `Eliminar rojas (${cnt('red')})`);
  setTxt('rec-reviewed-n', `(${recAlertRows.filter(a => a.reviewed).length})`);
}
