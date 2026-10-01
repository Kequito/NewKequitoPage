/* Vista Top Team Leader — ranking, baneados y comparador de evolución. */

/* ══════════════════════════════
   TOP TEAM LEADER — ranking + evolución con comparador multi-TL
   Se alimenta de un Excel con 27 columnas (reporte "Team Leader Mensual");
   solo importan "Team Leader", "All calls - Unique Orders" y
   "Call resulting statuses - Approve", pero se guardan las 27 tal cual
   vienen (mismo criterio que Approve Stats) por si hacen falta después.
══════════════════════════════ */
const TL_COL_UNIQUE_ORDERS = 'All calls - Unique Orders';
const TL_COL_APPROVE       = 'Call resulting statuses - Approve';

function tlParseWorkbook(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (raw.length === 0) return [];

  const headers = Object.keys(raw[0]);
  const tlKey = headers.find(h => recNormalizeHeader(h) === 'team leader');

  return raw.map(row => {
    const teamLeader = tlKey ? String(row[tlKey] ?? '').trim() : '';
    if (!teamLeader) return null;

    const record = { 'Team Leader': teamLeader };
    headers.forEach(h => {
      if (h === tlKey) return;
      record[h] = opsCoerceValue(h, row[h]);
    });
    return record;
  }).filter(Boolean);
}

async function tlDeleteAllCurrent() {
  const res = await fetch(`${SB_URL}/rest/v1/dt_tl_stats?${encodeURIComponent('Team Leader')}=not.is.null`, {
    method: 'DELETE',
    headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error(`Supabase delete error ${res.status}`);
}

async function tlFetchLastUpload() {
  try {
    const rows = await sbFetch('dt_tl_stats', 'select=uploaded_at&order=uploaded_at.desc&limit=1');
    return (rows && rows.length > 0) ? rows[0].uploaded_at : null;
  } catch (err) {
    console.error('Error obteniendo fecha de carga de dt_tl_stats:', err);
    return null;
  }
}

let tlLoaded = false;
let tlCurrentRows  = [];   // [{teamLeader, uniqueOrders, approve, approvePct, deltaPct}], orden desc por approvePct — SIN filtrar por baneados
let tlPrevSnapshot = null; // último snapshot guardado — deltas siempre se calculan contra este, se guarde o no ahora
let tlHistory      = [];
let tlDateFilter   = '7d';  // arranca en la última semana; cada quien lo cambia con los botones
let tlChartSeries  = new Set(); // nombres de Team Leader seleccionados para el comparador
let tlChartInstance = null;
let tlBannedRows   = []; // [{team_leader, banned_by, banned_at}] — tal cual viene de dt_tl_banned
let tlBannedSet    = new Set(); // solo los nombres, para filtrar rápido tabla/comparador

async function tlFetchBanned() {
  try {
    return await sbFetch('dt_tl_banned', 'select=*&order=banned_at.desc');
  } catch (err) {
    console.error('Error cargando Team Leaders baneados:', err);
    return [];
  }
}

/* Ocultar del ranking y del comparador no borra nada — dt_tl_stats/dt_tl_history
   siguen recibiendo y guardando su data con normalidad, esto es puramente de visibilidad. */
async function tlBanTeamLeader(name) {
  if (!can('tl.manage')) return;
  const ok = await uiConfirm(
    `"${name}" dejará de aparecer en el ranking y en el comparador.\n\nSu data se sigue guardando con normalidad — puedes restaurarlo cuando quieras desde la lista de Baneados.`,
    { title: '¿Banear Team Leader?', confirmText: 'Banear', danger: true },
  );
  if (!ok) return;
  try {
    const user = getCurrentUser();
    await sbInsert('dt_tl_banned', [{ team_leader: name, banned_by: user ? user[0] : null }]);
    await loadTlStats();
  } catch (err) {
    console.error('Error baneando Team Leader:', err);
    uiAlert('No se pudo excluir al Team Leader, intenta de nuevo.', { title: 'Error', tone: 'danger' });
  }
}

async function tlUnbanTeamLeader(name) {
  if (!can('tl.manage')) return;
  try {
    const res = await fetch(`${SB_URL}/rest/v1/dt_tl_banned?team_leader=eq.${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: SB_HEADERS,
    });
    if (!res.ok) throw new Error(`Supabase delete error ${res.status}`);
    await loadTlStats();
  } catch (err) {
    console.error('Error restaurando Team Leader:', err);
    uiAlert('No se pudo restaurar al Team Leader, intenta de nuevo.', { title: 'Error', tone: 'danger' });
  }
}

function renderTlBannedPanel() {
  document.getElementById('tl-banned-count').textContent = `(${tlBannedRows.length})`;
  const table = document.getElementById('tl-banned-table');
  const empty = document.getElementById('tl-banned-empty');
  const tbody = document.getElementById('tl-banned-tbody');

  if (tlBannedRows.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  table.style.display = 'table';

  tbody.innerHTML = tlBannedRows.map(b => {
    const stats = tlCurrentRows.find(r => r.teamLeader === b.team_leader);
    const d = new Date(b.banned_at);
    return `<tr>
      <td>${recTlBadge(b.team_leader)}</td>
      <td>${stats ? stats.uniqueOrders.toLocaleString('es-PE') : '—'}</td>
      <td>${stats ? stats.approve.toLocaleString('es-PE') : '—'}</td>
      <td>${stats ? stats.approvePct.toFixed(2) + '%' : '—'}</td>
      <td class="tl-date">${d.toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'})} · ${escapeHtml(b.banned_by) || '—'}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="tlUnbanTeamLeader(${jsArg(b.team_leader)})">↩ Restaurar</button></td>
    </tr>`;
  }).join('');
}

function tlComputeRanking(rawRows) {
  const rows = (rawRows || []).map(r => {
    const teamLeader   = (r['Team Leader'] || '').trim();
    const uniqueOrders = Number(r[TL_COL_UNIQUE_ORDERS]) || 0;
    const approve      = Number(r[TL_COL_APPROVE]) || 0;
    const approvePct   = uniqueOrders > 0 ? (approve / uniqueOrders) * 100 : 0;
    return { teamLeader, uniqueOrders, approve, approvePct };
  }).filter(r => r.teamLeader);
  rows.sort((a, b) => b.approvePct - a.approvePct);
  return rows;
}

/* Últimos avances guardados (el más nuevo primero). Con 10 alcanza para encontrar el anterior
   DISTINTO a la data actual aunque se haya guardado varias veces seguidas lo mismo. */
async function tlFetchRecentSnapshots() {
  try {
    return await sbFetch('dt_tl_history', 'select=created_at,rows&order=created_at.desc&limit=10');
  } catch (err) {
    console.error('Error cargando avances anteriores de Team Leaders:', err);
    return [];
  }
}

/* Lo que se guarda en dt_tl_history.rows */
function tlSnapshotRows() {
  return tlCurrentRows.map(r => ({ teamLeader: r.teamLeader, uniqueOrders: r.uniqueOrders, approve: r.approve, approvePct: r.approvePct }));
}

/* ¿Ese avance guardado es igual a la data actual? (mismos TL, mismas órdenes y approves) */
function tlSameAsCurrent(snapRows) {
  if (!Array.isArray(snapRows) || snapRows.length !== tlCurrentRows.length) return false;
  const byName = new Map(snapRows.map(r => [r.teamLeader, r]));
  return tlCurrentRows.every(r => {
    const s = byName.get(r.teamLeader);
    return s && Number(s.uniqueOrders) === r.uniqueOrders && Number(s.approve) === r.approve;
  });
}

let tlLastSnapshot = null;   // el avance guardado más reciente (para no guardar dos veces lo mismo)
let tlLastUploadIso = null;  // fecha de la última carga del Excel (va en la imagen exportada)

async function loadTlStats() {
  tlLoaded = true;
  const sup = can('tl.manage');
  document.getElementById('tl-save-wrap').style.display = sup ? 'flex' : 'none';
  document.getElementById('tl-banned-panel').style.display = sup ? 'block' : 'none';

  try {
    // tlFetchBanned() se pide siempre (no solo a Supervisores) — hace falta para FILTRAR la tabla/comparador
    // en cualquier sesión; lo que sí queda exclusivo a Supervisor es el panel que lista y restaura baneados.
    const [rawRows, lastUpload, recentSnaps, bannedRows] = await Promise.all([
      sbFetch('dt_tl_stats', 'select=*'),
      tlFetchLastUpload(),
      tlFetchRecentSnapshots(),
      tlFetchBanned(),
    ]);
    tlCurrentRows = tlComputeRanking(rawRows);
    tlBannedRows = bannedRows;
    tlBannedSet = new Set(bannedRows.map(r => r.team_leader));
    tlLastUploadIso = lastUpload;
    tlLastSnapshot = recentSnaps[0] || null;
    // Las flechas comparan contra el último avance DISTINTO a lo que se ve ahora: si el avance más
    // reciente es esta misma data (se guardó recién, a mano o solo al subir el Excel), todas saldrían "estable".
    tlPrevSnapshot = recentSnaps.find(s => !tlSameAsCurrent(s.rows)) || null;
    tlApplyComparisons();

    if (lastUpload) {
      const d = new Date(lastUpload);
      document.getElementById('tl-last-update').textContent =
        `Última carga: ${d.toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'})} ${d.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}`;
    } else {
      document.getElementById('tl-last-update').textContent = '';
    }

    renderTlTable();
    if (sup) renderTlBannedPanel();
  } catch (err) {
    console.error('Error cargando Top Team Leader:', err);
  }

  tlSyncMonthButtons();
  tlLoadHistory();
}

/* ══════════════════════════════
   COMPARACIONES — cambio de %, cambio de puesto y "poco volumen"
══════════════════════════════ */

/* Un TL con muy pocas órdenes puede tener un % altísimo por casualidad (10 de 20 = 50 %).
   "Poco volumen" = menos de este porcentaje de la MEDIANA de Unique Orders de los TL visibles.
   Es relativo a propósito: a principio de mes todos tienen pocas órdenes y nadie queda marcado. */
const TL_LOW_VOLUME_RATIO = 0.25;

function tlVisibleRows() {
  return tlCurrentRows.filter(r => !tlBannedSet.has(r.teamLeader));   // ya vienen ordenados por % desc
}

function tlMedian(values) {
  const v = values.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

let tlLowVolumeMin = 0;   // mínimo de Unique Orders para no quedar como "poco volumen"

function tlApplyComparisons() {
  const visible = tlVisibleRows();
  const prevRows = ((tlPrevSnapshot && tlPrevSnapshot.rows) || [])
    .filter(p => !tlBannedSet.has(p.teamLeader))
    .slice().sort((a, b) => b.approvePct - a.approvePct);
  const prevRank = new Map(prevRows.map((p, i) => [p.teamLeader, i + 1]));
  const prevPct = new Map(prevRows.map(p => [p.teamLeader, Number(p.approvePct)]));
  tlLowVolumeMin = Math.round(tlMedian(visible.map(r => r.uniqueOrders)) * TL_LOW_VOLUME_RATIO);

  tlCurrentRows.forEach(r => {
    r.deltaPct = prevPct.has(r.teamLeader) ? r.approvePct - prevPct.get(r.teamLeader) : null;
  });
  visible.forEach((r, i) => {
    r.rank = i + 1;
    // + = subió puestos. 'new' = no estaba en el avance anterior. null = no hay avance anterior.
    r.rankDelta = !tlPrevSnapshot ? null : (prevRank.has(r.teamLeader) ? prevRank.get(r.teamLeader) - r.rank : 'new');
    r.lowVolume = tlLowVolumeMin > 0 && r.uniqueOrders < tlLowVolumeMin;
  });
}

function tlRankDeltaHTML(d) {
  if (d === null || d === undefined) return '';
  if (d === 'new') return '<span class="tl-move tl-move-new" title="No estaba en el avance anterior">nuevo</span>';
  if (d === 0) return '<span class="tl-move tl-move-flat" title="Mismo puesto que en el avance anterior">= puesto</span>';
  const up = d > 0, n = Math.abs(d);
  return `<span class="tl-move ${up ? 'tl-move-up' : 'tl-move-down'}" title="${up ? 'Subió' : 'Bajó'} ${n} puesto${n === 1 ? '' : 's'} desde el avance anterior">${up ? '▲' : '▼'} ${n} puesto${n === 1 ? '' : 's'}</span>`;
}

function tlLowVolumeHTML(r) {
  return r.lowVolume
    ? `<span class="tl-low" title="Solo ${r.uniqueOrders.toLocaleString('es-PE')} Unique Orders (mínimo para el podio: ${tlLowVolumeMin.toLocaleString('es-PE')}). Con tan pocas órdenes el % puede ser casualidad.">⚠ poco volumen</span>`
    : '';
}

/* ══════════════════════════════
   "TÚ ESTÁS AQUÍ" — la cuenta que entró se busca por NOMBRE en la columna Team Leader del Excel
══════════════════════════════ */
function tlNameKey(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/* 1) mismo nombre (sin importar mayúsculas, tildes ni espacios); 2) si no, todas las palabras del nombre
   más corto están en el otro ("Kevin Rojas" ↔ "Kevin Rojas Vega") — solo si hay UN candidato, para no confundir. */
function tlFindMe(rows) {
  const me = getCurrentUser();
  const key = tlNameKey(me && me[0]);
  if (!key) return null;
  const exact = rows.find(r => tlNameKey(r.teamLeader) === key);
  if (exact) return exact;
  const mine = key.split(' ');
  if (mine.length < 2) return null;
  const candidates = rows.filter(r => {
    const theirs = tlNameKey(r.teamLeader).split(' ');
    if (theirs.length < 2) return false;
    const [short, long] = theirs.length <= mine.length ? [theirs, mine] : [mine, theirs];
    return short.every(w => long.includes(w));
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function tlGapText(me, other, verb) {
  const diff = Math.abs(me.approvePct - other.approvePct);
  if (diff < 0.005) return `Estás <strong>empatado</strong> en % con ${escapeHtml(other.teamLeader)} (#${other.rank}).`;
  return `${verb} <strong>${diff.toFixed(2)} pts</strong> ${verb.startsWith('Te faltan') ? 'para alcanzar a' : 'a'} ${escapeHtml(other.teamLeader)} (#${other.rank}).`;
}

function tlRenderMe(visible) {
  const box = document.getElementById('tl-me');
  const me = tlFindMe(visible);
  if (!me) { box.hidden = true; box.innerHTML = ''; return; }
  const above = visible[me.rank - 2], below = visible[me.rank];
  const gap = above
    ? tlGapText(me, above, 'Te faltan')
    : (below ? `¡Vas primero! ${tlGapText(me, below, 'Le sacas')}` : '¡Vas primero!');
  box.innerHTML = `
    ${eqAvatar(me.teamLeader, true)}
    <div class="tl-me-main">
      <div class="tl-me-eyebrow">📍 Tú estás aquí</div>
      <div class="tl-me-rank">#${me.rank} <span>de ${visible.length}</span></div>
      <div class="tl-me-gap">${gap}</div>
      ${me.lowVolume ? `<div class="tl-me-note">${tlLowVolumeHTML(me)} Todavía tienes pocas órdenes comparado con el resto: tu % puede moverse mucho.</div>` : ''}
    </div>
    <div class="tl-me-stats">
      <div class="tl-me-pct">${me.approvePct.toFixed(2)}%</div>
      <div class="tl-me-moves">${repDeltaHTML(me.deltaPct)} ${tlRankDeltaHTML(me.rankDelta)}</div>
      <div class="tl-me-sub">${me.approve.toLocaleString('es-PE')} approve de ${me.uniqueOrders.toLocaleString('es-PE')} órdenes</div>
    </div>`;
  box.hidden = false;
}

/* ══════════════════════════════
   PODIO — top 3 SIN "poco volumen" (en la tabla siguen apareciendo todos, con su aviso)
══════════════════════════════ */
const TL_MEDALS = ['🥇', '🥈', '🥉'];

function tlPodiumRows(visible) { return visible.filter(r => !r.lowVolume).slice(0, 3); }

/* Orden visual 2º · 1º · 3º (el primero al centro y más alto) */
function tlPodiumHTML(top) {
  return [1, 0, 2].filter(i => top[i]).map(i => {
    const r = top[i];
    return `<div class="tl-pod tl-pod-${i + 1}">
      <div class="tl-pod-medal">${TL_MEDALS[i]}</div>
      ${eqAvatar(r.teamLeader, true)}
      <div class="tl-pod-name" title="${escapeHtml(r.teamLeader)}">${escapeHtml(r.teamLeader)}</div>
      <div class="tl-pod-pct">${r.approvePct.toFixed(2)}%</div>
      <div class="tl-pod-sub">${r.approve.toLocaleString('es-PE')} de ${r.uniqueOrders.toLocaleString('es-PE')} órdenes</div>
      <div class="tl-pod-moves">${repDeltaHTML(r.deltaPct)} ${tlRankDeltaHTML(r.rankDelta)}</div>
      <div class="tl-pod-base">${i + 1}</div>
    </div>`;
  }).join('');
}

function tlRenderPodium(visible) {
  const box = document.getElementById('tl-podium');
  const top = tlPodiumRows(visible);
  box.hidden = top.length === 0;
  box.innerHTML = top.length ? tlPodiumHTML(top) : '';
}

/* Explicación de los íconos, solo de lo que realmente aparece en la tabla */
function tlRenderLegend(visible) {
  const el = document.getElementById('tl-legend');
  const parts = [];
  if (tlPrevSnapshot) {
    const d = new Date(tlPrevSnapshot.created_at);
    parts.push(`Flechas y puestos comparados con el avance del ${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })} a las ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}.`);
  }
  if (visible.some(r => r.lowVolume)) {
    parts.push(`<span class="tl-low">⚠ poco volumen</span> = menos de ${tlLowVolumeMin.toLocaleString('es-PE')} Unique Orders (la cuarta parte de lo que tiene un TL típico este mes): no entra al podio porque su % todavía puede ser casualidad.`);
  }
  el.innerHTML = parts.join(' ');
  el.hidden = parts.length === 0;
}

/* Color por rango: mejor cuartil verde, peor cuartil rojo, resto neutro —
   tiene más sentido en un ranking que un umbral fijo, ya que acá el % es Approve/Unique Orders,
   una proporción distinta (y normalmente mucho más baja) que el Approve% de Reportes/Approve Stats. */
function tlRankClass(index, total) {
  if (total <= 1) return 'rep-approve-mid';
  const p = index / (total - 1); // 0 = mejor, 1 = peor (tlCurrentRows ya viene ordenado desc)
  if (p <= 0.25) return 'rep-approve-good';
  if (p >= 0.75) return 'rep-approve-bad';
  return 'rep-approve-mid';
}

/* Filas de la tabla del ranking. La usa la tabla de la página (con botón Banear) y la imagen exportada (sin). */
function tlTableHeadHTML(withActions) {
  return `<tr>
    <th>#</th><th>Team Leader</th><th class="num">Unique Orders</th><th class="num">Approve</th><th>Approve %</th><th>Puesto</th>${withActions ? '<th>Acción</th>' : ''}
  </tr>`;
}

function tlTableRowsHTML(visible, { withActions = false, meName = null } = {}) {
  return visible.map((r, i) => {
    const cls = tlRankClass(i, visible.length);
    const isMe = meName && r.teamLeader === meName;
    return `<tr class="${isMe ? 'tl-row-me' : ''}">
      <td class="dash-rank">${r.rank}</td>
      <td class="nowrap">${recTlBadge(r.teamLeader)}${isMe ? ' <span class="tl-you">Tú</span>' : ''} ${tlLowVolumeHTML(r)}</td>
      <td class="num">${r.uniqueOrders.toLocaleString('es-PE')}</td>
      <td class="num">${r.approve.toLocaleString('es-PE')}</td>
      <td class="nowrap"><span class="rep-approve-badge ${cls}">${r.approvePct.toFixed(2)}%</span> ${repDeltaHTML(r.deltaPct)}</td>
      <td class="nowrap">${tlRankDeltaHTML(r.rankDelta) || '<span class="txt-light">—</span>'}</td>
      ${withActions ? `<td><button class="btn btn-ghost btn-sm" onclick="tlBanTeamLeader(${jsArg(r.teamLeader)})" title="Excluir del ranking y del comparador">🚫 Banear</button></td>` : ''}
    </tr>`;
  }).join('');
}

function renderTlTable() {
  const table = document.getElementById('tl-table');
  const empty = document.getElementById('tl-empty');
  const sup = can('tl.manage');

  // Los baneados no existen para esta tabla — ni para Team Leaders ni para Supervisores.
  // Su data sigue intacta en tlCurrentRows/dt_tl_stats, esto es puramente de visibilidad.
  const visible = tlVisibleRows();
  document.getElementById('tl-thead').innerHTML = tlTableHeadHTML(sup);
  document.querySelector('.tl-export-actions').hidden = visible.length === 0;

  tlRenderMe(visible);
  tlRenderPodium(visible);
  tlRenderLegend(visible);

  if (visible.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  table.style.display = 'table';

  const me = tlFindMe(visible);
  document.getElementById('tl-tbody').innerHTML = tlTableRowsHTML(visible, { withActions: sup, meName: me && me.teamLeader });
}

/* Inserta la foto actual del ranking en dt_tl_history. Devuelve false si no hacía falta
   (el último avance guardado ya es exactamente esta data: así no se duplican puntos). */
async function tlInsertSnapshot(auto) {
  if (tlLastSnapshot && tlSameAsCurrent(tlLastSnapshot.rows)) return false;
  const user = getCurrentUser();
  const by = user ? user[0] : null;
  await sbInsert('dt_tl_history', [{ created_by: auto && by ? `${by} (automático)` : by, rows: tlSnapshotRows() }]);
  return true;
}

/* Guarda el ranking actual como un nuevo punto de evolución — botón manual */
async function tlSaveSnapshot() {
  if (!can('tl.manage') || tlCurrentRows.length === 0) return;
  const btn = document.getElementById('tl-save-btn');
  const status = document.getElementById('tl-save-status');
  btn.disabled = true;
  status.style.color = 'var(--text-light)';
  status.textContent = 'Guardando...';
  try {
    const saved = await tlInsertSnapshot(false);
    status.style.color = saved ? 'var(--green)' : 'var(--text-light)';
    status.textContent = saved ? '✓ Avance guardado' : 'Ya estaba guardado — no hay cambios desde el último avance';
    if (saved) await loadTlStats(); // refresca el historial del comparador
  } catch (err) {
    console.error('Error guardando avance de Team Leaders:', err);
    status.style.color = 'var(--red)';
    status.textContent = 'Error al guardar, intenta de nuevo';
  } finally {
    btn.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 4000);
  }
}

/* Guardado AUTOMÁTICO: lo llama Actualización de Data justo después de subir el Excel de Top TL
   (ya con loadTlStats hecho). Devuelve un texto corto para el mensaje de "✓ Listo". Nunca lanza error:
   la subida del Excel ya salió bien y no debe verse como fallida por esto. */
async function tlAutoSaveSnapshot() {
  if (!tlCurrentRows.length) return '';
  if (!can('tl.manage')) return 'avance NO guardado (tu cuenta no tiene el permiso de Top Team Leader)';
  try {
    const saved = await tlInsertSnapshot(true);
    if (saved) await loadTlStats();
    return saved ? 'avance guardado en la evolución' : '';
  } catch (err) {
    console.error('Error en el guardado automático del avance de Team Leaders:', err);
    return 'no se pudo guardar el avance (puedes usar "Guardar avance" en Top Team Leader)';
  }
}

/* ── Evolución / comparador — mismo patrón de filtros de fecha que Reportes ── */
function tlLocalDayStart(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

/* Primer día (00:00) del mes actual + offset (0 = este mes, -1 = el anterior) */
function tlMonthStart(offset) { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + offset, 1); }
function tlMonthName(offset) {
  const s = tlMonthStart(offset).toLocaleDateString('es-PE', { month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* Solo 5 rangos: hoy, ayer, 7 días, mes actual y mes anterior */
const TL_DATE_FILTERS = ['today', 'yesterday', '7d', 'month', 'prevmonth'];
function tlDateBoundsFor(filter) {
  if (filter === 'today') return { start: tlLocalDayStart(0), end: tlLocalDayStart(1) };
  if (filter === 'yesterday') return { start: tlLocalDayStart(-1), end: tlLocalDayStart(0) };
  if (filter === 'month') return { start: tlMonthStart(0), end: tlMonthStart(1) };
  if (filter === 'prevmonth') return { start: tlMonthStart(-1), end: tlMonthStart(0) };
  const end = new Date(); const start = new Date(); start.setDate(start.getDate() - 7);   // '7d'
  return { start, end };
}

/* Los botones de mes llevan el nombre real ("Septiembre (en curso)", "Agosto") */
function tlSyncMonthButtons() {
  const cur = document.querySelector('.tl-date-btn[data-filter="month"]');
  const prev = document.querySelector('.tl-date-btn[data-filter="prevmonth"]');
  if (cur) cur.textContent = `${tlMonthName(0)} (en curso)`;
  if (prev) prev.textContent = tlMonthName(-1);
}

function tlSetDateFilter(value) {
  if (!TL_DATE_FILTERS.includes(value)) return;
  tlDateFilter = value;
  document.querySelectorAll('.tl-date-btn').forEach(b => {
    const active = b.dataset.filter === value;
    b.classList.toggle('btn-primary', active);
    b.classList.toggle('btn-ghost', !active);
  });
  tlLoadHistory();
}

async function tlFetchSnapshotsForRange(filter) {
  try {
    const bounds = tlDateBoundsFor(filter);
    let query = 'select=created_at,rows&order=created_at.asc&limit=500';
    if (bounds) {
      query += `&created_at=gte.${encodeURIComponent(bounds.start.toISOString())}`;
      query += `&created_at=lt.${encodeURIComponent(bounds.end.toISOString())}`;
    }
    return await sbFetch('dt_tl_history', query);
  } catch (err) {
    console.error('Error cargando historial de Team Leaders:', err);
    return [];
  }
}

/* En rangos de varios días se muestra UN punto por día: el último avance guardado ese día
   (así guardar varias veces en un día no llena la gráfica de barras repetidas).
   En "Hoy", "Ayer" o una fecha puntual se ven todos los avances de ese día, hora por hora. */
const TL_PER_DAY_FILTERS = ['7d', 'month', 'prevmonth'];
function tlChartPerDay() { return TL_PER_DAY_FILTERS.includes(tlDateFilter); }
function tlChartPoints() { return tlChartPerDay() ? dashLastSnapshotPerDay(tlHistory) : tlHistory; }

async function tlLoadHistory() {
  tlHistory = await tlFetchSnapshotsForRange(tlDateFilter);
  const n = tlHistory.length;
  const saved = `${n} avance${n !== 1 ? 's' : ''} guardado${n !== 1 ? 's' : ''}`;
  const days = tlChartPoints().length;
  document.getElementById('tl-snap-count').textContent = tlChartPerDay()
    ? `${days} día${days !== 1 ? 's' : ''} · ${saved} (se muestra el último de cada día)`
    : `${saved} en este rango`;

  // Si todavía no hay nada seleccionado, arranca mostrando el top 3 actual (sin baneados) para que no salga vacío
  if (tlChartSeries.size === 0 && tlCurrentRows.length > 0) {
    tlCurrentRows.filter(r => !tlBannedSet.has(r.teamLeader)).slice(0, 3).forEach(r => tlChartSeries.add(r.teamLeader));
  }

  renderTlChips();
  renderTlChart();
}

function renderTlChips() {
  // Un baneado no debe quedar seleccionado en el comparador aunque lo haya estado antes de banearlo
  tlBannedSet.forEach(name => tlChartSeries.delete(name));

  const wrap = document.getElementById('tl-chart-toggles');
  const allNames = [...new Set([
    ...tlCurrentRows.map(r => r.teamLeader),
    ...tlHistory.flatMap(h => (h.rows || []).map(r => r.teamLeader)),
  ])].filter(name => !tlBannedSet.has(name)).sort();

  if (allNames.length === 0) {
    wrap.innerHTML = '';
    return;
  }

  wrap.innerHTML = allNames.map(name => {
    const on = tlChartSeries.has(name);
    const color = (recColorForName(name) || {}).color || '#9ca8b5';
    return `<button type="button" class="rep-toggle-chip color-chip ${on ? '' : 'off'}" style="--c:${color}" aria-pressed="${on}" onclick="tlToggleSeries(${jsArg(name)})">${escapeHtml(name)}</button>`;
  }).join('');
}

function tlToggleSeries(name) {
  if (tlChartSeries.has(name)) tlChartSeries.delete(name);
  else tlChartSeries.add(name);
  renderTlChips();
  renderTlChart();
}

function tlFmtTimestamp(iso) {
  const d = new Date(iso);
  if (tlChartPerDay()) {   // un punto por día: basta con el día ("lun 29/09")
    return d.toLocaleDateString('es-PE', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '');
  }
  const fmt = (tlDateFilter === 'today' || tlDateFilter === 'yesterday')
    ? { hour: '2-digit', minute: '2-digit' }
    : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' };
  return d.toLocaleString('es-PE', fmt);
}

function renderTlChart() {
  const canvas = document.getElementById('tlChart');
  const emptyEl = document.getElementById('tl-chart-empty');
  const wrapEl = document.getElementById('tl-chart-wrap');

  if (tlHistory.length === 0 || tlChartSeries.size === 0) {
    emptyEl.style.display = 'flex';
    wrapEl.style.display = 'none';
    if (tlChartInstance) { tlChartInstance.destroy(); tlChartInstance = null; }
    return;
  }
  emptyEl.style.display = 'none';
  wrapEl.style.display = 'block';

  const points = tlChartPoints();
  const labels = points.map(h => tlFmtTimestamp(h.created_at));

  // Barras agrupadas en vez de líneas — más fácil de leer de un vistazo para los Team Leaders
  const datasets = [...tlChartSeries].sort().map(name => {
    const color = (recColorForName(name) || {}).color || '#9ca8b5';
    const values = points.map(h => {
      const found = (h.rows || []).find(r => r.teamLeader === name);
      return (found && found.approvePct !== undefined && found.approvePct !== null) ? Number(Number(found.approvePct).toFixed(1)) : null;
    });
    return {
      type: 'bar', label: name, data: values,
      backgroundColor: color, borderRadius: 4, borderSkipped: false,
    };
  });

  const seen = datasets.flatMap(d => d.data).filter(v => v !== null && v !== undefined);
  const dataMax = seen.length ? Math.max(...seen) : 0;
  const axisMax = Math.min(100, Math.max(REP_CHART_MAX_DEFAULT, Math.ceil((dataMax + 5) / 5) * 5));

  if (tlChartInstance) tlChartInstance.destroy();
  tlChartInstance = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { ...chartDefaults.font, boxWidth: 12 } },
        datalabels: {
          display: (ctx) => ctx.dataset.data[ctx.dataIndex] !== null && ctx.dataset.data[ctx.dataIndex] !== undefined,
          formatter: (value) => `${value}%`,
          color: '#fff',
          textStrokeColor: 'rgba(0,0,0,.55)',
          textStrokeWidth: 3,
          font: { family: "'Lexend', sans-serif", weight: '700', size: 15 },
          anchor: 'center',
          align: 'center',
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { ...chartDefaults.font } },
        y: { grid: { color: CHART_GRID }, ticks: { ...chartDefaults.font, callback: v => v + '%' }, min: 0, max: axisMax },
      },
    },
  });
}

/* ══════════════════════════════
   EXPORTAR COMO IMAGEN — podio + ranking completo, para WhatsApp
   Se arma una tarjeta aparte, fuera de la vista y con ancho fijo (.tl-export en views.css): la imagen
   sale igual para todos, sin importar el tamaño de la pantalla, el zoom o el celular. Sin botones ni "Tú".
   html2canvas se carga solo la primera vez (repLoadHtml2Canvas, en reportes.js).
══════════════════════════════ */
function tlFmtDateTime(iso) {
  const d = iso ? new Date(iso) : new Date();
  return `${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}

function tlBuildExportCard() {
  const visible = tlVisibleRows();
  const top = tlPodiumRows(visible);
  const card = document.createElement('div');
  card.className = 'tl-export';
  card.innerHTML = `
    <div class="tl-export-head">
      <div class="tl-export-title">🏆 Top Team Leader</div>
      <div class="tl-export-stamp">${escapeHtml(tlFmtDateTime(tlLastUploadIso))}</div>
    </div>
    ${top.length ? `<div class="tl-podium">${tlPodiumHTML(top)}</div>` : ''}
    <table class="tl-export-table">
      <thead>${tlTableHeadHTML(false)}</thead>
      <tbody>${tlTableRowsHTML(visible)}</tbody>
    </table>
    <div class="tl-export-foot">% Approve = Approve ÷ Unique Orders · Datos de la carga del ${escapeHtml(tlFmtDateTime(tlLastUploadIso))}${
      visible.some(r => r.lowVolume) ? ` · ⚠ poco volumen = menos de ${tlLowVolumeMin.toLocaleString('es-PE')} Unique Orders (no entra al podio)` : ''}</div>`;
  return card;
}

function tlExportImage(action) {
  if (!tlVisibleRows().length) return;
  return exportCardImage({
    action, build: tlBuildExportCard,
    filename: `top-team-leader-${eqLocalDateStamp()}.png`,
    statusId: 'tl-export-status', buttonIds: ['tl-copy-img-btn', 'tl-dl-img-btn'],
  });
}
