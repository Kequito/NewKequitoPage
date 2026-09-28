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
let tlDateFilter   = 'all'; // el reporte es mensual, "hoy" casi siempre saldría vacío
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
  if (!isSupervisor()) return;
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
  if (!isSupervisor()) return;
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
      <td style="color:var(--text-light);white-space:nowrap">${d.toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'})} · ${escapeHtml(b.banned_by) || '—'}</td>
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

async function tlFetchPrevSnapshot() {
  try {
    const rows = await sbFetch('dt_tl_history', 'select=created_at,rows&order=created_at.desc&limit=1');
    return (rows && rows.length > 0) ? rows[0] : null;
  } catch (err) {
    console.error('Error cargando snapshot anterior de Team Leaders:', err);
    return null;
  }
}

async function loadTlStats() {
  tlLoaded = true;
  const sup = isSupervisor();
  document.getElementById('tl-save-wrap').style.display = sup ? 'flex' : 'none';
  document.getElementById('tl-banned-panel').style.display = sup ? 'block' : 'none';

  try {
    // tlFetchBanned() se pide siempre (no solo a Supervisores) — hace falta para FILTRAR la tabla/comparador
    // en cualquier sesión; lo que sí queda exclusivo a Supervisor es el panel que lista y restaura baneados.
    const [rawRows, lastUpload, prevSnap, bannedRows] = await Promise.all([
      sbFetch('dt_tl_stats', 'select=*'),
      tlFetchLastUpload(),
      tlFetchPrevSnapshot(),
      tlFetchBanned(),
    ]);
    tlPrevSnapshot = prevSnap;
    tlCurrentRows = tlComputeRanking(rawRows);
    tlBannedRows = bannedRows;
    tlBannedSet = new Set(bannedRows.map(r => r.team_leader));

    // Deltas vs. el último snapshot guardado — independiente de si se guarda "ahora" o no
    const prevRows = prevSnap ? (prevSnap.rows || []) : [];
    tlCurrentRows.forEach(r => {
      const prev = prevRows.find(p => p.teamLeader === r.teamLeader);
      r.deltaPct = prev ? r.approvePct - prev.approvePct : null;
    });

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

  tlLoadHistory();
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

function renderTlTable() {
  const table = document.getElementById('tl-table');
  const empty = document.getElementById('tl-empty');
  const thead = document.getElementById('tl-thead');
  const tbody = document.getElementById('tl-tbody');
  const sup = isSupervisor();

  // Los baneados no existen para esta tabla — ni para Team Leaders ni para Supervisores.
  // Su data sigue intacta en tlCurrentRows/dt_tl_stats, esto es puramente de visibilidad.
  const visibleRows = tlCurrentRows.filter(r => !tlBannedSet.has(r.teamLeader));
  const total = visibleRows.length;

  thead.innerHTML = `<tr>
    <th>#</th><th>Team Leader</th><th>Unique Orders</th><th>Approve</th><th>Approve %</th>${sup ? '<th>Acción</th>' : ''}
  </tr>`;

  if (total === 0) {
    table.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  table.style.display = 'table';

  tbody.innerHTML = visibleRows.map((r, i) => {
    const cls = tlRankClass(i, total);
    return `<tr>
      <td style="font-weight:700;color:var(--text-light)">${i + 1}</td>
      <td>${recTlBadge(r.teamLeader)}</td>
      <td>${r.uniqueOrders.toLocaleString('es-PE')}</td>
      <td>${r.approve.toLocaleString('es-PE')}</td>
      <td style="white-space:nowrap"><span class="rep-approve-badge ${cls}">${r.approvePct.toFixed(2)}%</span> ${repDeltaHTML(r.deltaPct)}</td>
      ${sup ? `<td><button class="btn btn-ghost btn-sm" onclick="tlBanTeamLeader(${jsArg(r.teamLeader)})" title="Excluir del ranking y del comparador">🚫 Banear</button></td>` : ''}
    </tr>`;
  }).join('');
}

/* Guarda el ranking actual como un nuevo punto de evolución — acción manual, solo Supervisor */
async function tlSaveSnapshot() {
  if (!isSupervisor() || tlCurrentRows.length === 0) return;
  const btn = document.getElementById('tl-save-btn');
  const status = document.getElementById('tl-save-status');
  btn.disabled = true;
  status.style.color = 'var(--text-light)';
  status.textContent = 'Guardando...';
  try {
    const user = getCurrentUser();
    const rows = tlCurrentRows.map(r => ({
      teamLeader: r.teamLeader, uniqueOrders: r.uniqueOrders, approve: r.approve, approvePct: r.approvePct,
    }));
    await sbInsert('dt_tl_history', [{ created_by: user ? user[0] : null, rows }]);
    status.style.color = 'var(--green)';
    status.textContent = '✓ Avance guardado';
    await loadTlStats(); // refresca deltas (nuevo "último snapshot") y el historial del comparador
  } catch (err) {
    console.error('Error guardando avance de Team Leaders:', err);
    status.style.color = 'var(--red)';
    status.textContent = 'Error al guardar, intenta de nuevo';
  } finally {
    btn.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 3000);
  }
}

/* ── Evolución / comparador — mismo patrón de filtros de fecha que Reportes ── */
function tlLocalDayStart(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

function tlDateBoundsFor(filter) {
  if (filter === 'today') { const start = tlLocalDayStart(0); const end = tlLocalDayStart(1); return { start, end }; }
  if (filter === 'yesterday') { const start = tlLocalDayStart(-1); const end = tlLocalDayStart(0); return { start, end }; }
  if (filter === '7d') { const end = new Date(); const start = new Date(); start.setDate(start.getDate() - 7); return { start, end }; }
  if (filter === 'all') return null;
  const start = new Date(`${filter}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function tlSetDateFilter(value) {
  if (!value) return;
  tlDateFilter = value;
  document.querySelectorAll('.tl-date-btn').forEach(b => {
    const active = b.dataset.filter === value;
    b.classList.toggle('btn-primary', active);
    b.classList.toggle('btn-ghost', !active);
  });
  if (['today', 'yesterday', '7d', 'all'].includes(value)) {
    document.getElementById('tl-date-input').value = '';
  } else {
    document.querySelectorAll('.tl-date-btn').forEach(b => {
      b.classList.remove('btn-primary');
      b.classList.add('btn-ghost');
    });
  }
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

async function tlLoadHistory() {
  tlHistory = await tlFetchSnapshotsForRange(tlDateFilter);
  document.getElementById('tl-snap-count').textContent = `${tlHistory.length} snapshot${tlHistory.length !== 1 ? 's' : ''} en este rango`;

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
    return `<div class="rep-toggle-chip ${on ? '' : 'off'}" style="border-color:${color};color:${color}" onclick="tlToggleSeries(${jsArg(name)})">${escapeHtml(name)}</div>`;
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

  const labels = tlHistory.map(h => tlFmtTimestamp(h.created_at));

  // Barras agrupadas en vez de líneas — más fácil de leer de un vistazo para los Team Leaders
  const datasets = [...tlChartSeries].sort().map(name => {
    const color = (recColorForName(name) || {}).color || '#9ca8b5';
    const values = tlHistory.map(h => {
      const found = (h.rows || []).find(r => r.teamLeader === name);
      return (found && found.approvePct !== undefined && found.approvePct !== null) ? Number(found.approvePct.toFixed(1)) : null;
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
