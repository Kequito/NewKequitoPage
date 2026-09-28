/* Vista Reporte — panel de ventas pegado, snapshots y evolución. */

/* ══════════════════════════════
   REPORTES — Panel de Ventas (pegado + snapshots + evolución)
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

let repRows      = [];
let repHistory   = [];
let repLoaded    = false;
let repChartSeries   = 'Total'; // 'Total' o el nombre de un país — una sola serie a la vez
let repChartInstance = null;
// Techo por defecto del eje Y — 100% es correcto pero poco realista de ver.
// Sube esto a 100 el día que alguna estadística lo necesite de forma habitual.
const REP_CHART_MAX_DEFAULT = 75;

function repTogglePaste() {
  const body = document.getElementById('rep-paste-body');
  const chevron = document.getElementById('rep-paste-chevron');
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : 'block';
  chevron.style.transform = open ? 'rotate(-90deg)' : 'rotate(0deg)';
}

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

async function repGenerate() {
  const raw = document.getElementById('rep-raw-input').value;
  const errBox = document.getElementById('rep-parse-error');
  errBox.style.display = 'none';
  const parsed = repParsePanelData(raw);
  if (parsed.length === 0) {
    errBox.textContent = 'No pude reconocer filas válidas. Verifica que hayas pegado el bloque completo copiado del Panel (incluyendo encabezado).';
    errBox.style.display = 'flex';
    return;
  }
  repRows = parsed;
  document.getElementById('rep-empty-state').style.display = 'none';
  document.getElementById('rep-save-btn').style.display = isSupervisor() ? 'inline-flex' : 'none';

  const [prevSnap, todaySnaps] = await Promise.all([
    repFetchPrevSnapshot(),
    repFetchSnapshotsForRange('today'),
  ]);
  repPrevSnapshot = prevSnap;

  repRenderReport(todaySnaps);
  repTogglePaste();
}

let repByCountry    = [];
let repGlobal        = { total: 0, approved: 0, approvePct: 0 };
let repPrevSnapshot  = null;
let repSortCol       = null;
let repSortDir       = {};
const REP_SORT_KEYS = ['country','total','new','recall','noAnswer','approved','approvePct','reject','trash'];

function repRenderReport(todaySnapshots = []) {
  repByCountry = repAggregateByCountry(repRows);
  repGlobal = repGetGlobal(repRows);
  repSortCol = null;
  repSortDir = {};
  document.querySelectorAll('#rep-table-panel thead th').forEach(th => {
    th.classList.remove('sorted');
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = '↕';
  });

  // Deltas vs. el último snapshot guardado (independiente del filtro de la gráfica)
  const prevByCountry = repPrevSnapshot ? (repPrevSnapshot.by_country || []) : [];
  repByCountry.forEach(c => {
    const prev = prevByCountry.find(p => p.country === c.country);
    c.deltaPct = prev ? c.approvePct - prev.approvePct : null;
    c.prevApprovePct = prev ? prev.approvePct : null;
  });
  repGlobal.deltaPct = repPrevSnapshot ? repGlobal.approvePct - repPrevSnapshot.global.approvePct : null;
  repGlobal.prevApprovePct = repPrevSnapshot ? repPrevSnapshot.global.approvePct : null;

  repRenderSummary(todaySnapshots);
  repRenderKPIs();
  repRenderTableBody();
  repRenderTfoot();

  document.getElementById('rep-table-panel').style.display = 'block';
  repUpdateLastUpdatedLabel(null);
}

/* Caja azul grande de "última actualización" (mismo formato que Recalls) — usa la fecha
   y el autor del snapshot guardado, o el usuario actual cuando es una vista previa recién
   generada en este navegador (iso=null todavía no se ha guardado). */
function repUpdateLastUpdatedLabel(iso, name) {
  const box = document.getElementById('rep-lastupd-box');
  let finalName = name;
  if (!iso && !finalName) {
    const stored = sessionStorage.getItem(SESSION_KEY);
    const user = stored ? JSON.parse(stored) : null;
    finalName = user ? user[0] : null;
  }
  if (!finalName) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  const d = iso ? new Date(iso) : new Date();
  const fecha = d.toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' });
  const hora = d.toLocaleTimeString('es-ES', { hour:'2-digit', minute:'2-digit' });
  document.getElementById('rep-lastupd-name').textContent = finalName;
  document.getElementById('rep-lastupd-time').textContent = `${fecha} · ${hora}`;
}

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
  const gColor = gCls === 'rep-approve-good' ? 'var(--green)' : gCls === 'rep-approve-bad' ? 'var(--red)' : 'var(--text-dark)';
  const deltaHtml = repDeltaHTML(repGlobal.deltaPct);
  kpiWrap.innerHTML = `
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">Leads Totales</span></div>
      <div class="kpi-value">${repGlobal.total.toLocaleString('es-PE')}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">Aprobados</span></div>
      <div class="kpi-value" style="color:var(--green)">${repGlobal.approved.toLocaleString('es-PE')}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">% Approve Global</span></div>
      <div class="kpi-value" style="color:${gColor}">${repFmtPct(repGlobal.approvePct)}</div>
      ${deltaHtml ? `<div class="kpi-footer">${deltaHtml}<span class="kpi-sub">vs. snapshot anterior</span></div>` : ''}
      ${repGlobal.prevApprovePct != null ? `<div class="kpi-sub" style="color:var(--text-light);margin-top:2px">ayer: ${repFmtPct(repGlobal.prevApprovePct)}</div>` : ''}
    </div>`;
  kpiWrap.style.display = 'grid';
}

function repRenderTableBody() {
  const tbody = document.getElementById('rep-tbody');
  tbody.innerHTML = repByCountry.map(c => {
    const cls = repApproveClass(c.approvePct);
    return `<tr>
      <td style="font-weight:600;white-space:nowrap">${countryFlag(c.country)}${c.country}</td>
      <td>${c.total.toLocaleString('es-PE')}</td>
      <td style="color:var(--text-light)">${c.new}</td>
      <td style="color:var(--text-light)">${c.recall}</td>
      <td style="color:var(--text-light)">${c.noAnswer}</td>
      <td>${c.approved}</td>
      <td style="white-space:nowrap">
        <span class="rep-approve-badge ${cls}">${repFmtPct(c.approvePct)}</span> ${repDeltaHTML(c.deltaPct)}
        ${c.prevApprovePct != null ? `<div style="color:var(--text-light);font-size:11px;font-weight:600;margin-top:2px">ayer: ${repFmtPct(c.prevApprovePct)}</div>` : ''}
      </td>
      <td style="color:var(--text-light)">${c.reject}</td>
      <td style="color:var(--text-light)">${c.trash}</td>
    </tr>`;
  }).join('');
}

function repRenderTfoot() {
  const gCls = repApproveClass(repGlobal.approvePct);
  const tfoot = document.getElementById('rep-tfoot');
  tfoot.innerHTML = `<tr style="font-weight:700">
    <td>Total</td>
    <td>${repGlobal.total.toLocaleString('es-PE')}</td>
    <td></td><td></td><td></td>
    <td>${repGlobal.approved.toLocaleString('es-PE')}</td>
    <td><span class="rep-approve-badge ${gCls}">${repFmtPct(repGlobal.approvePct)}</span></td>
    <td></td><td></td>
  </tr>`;
}

function repSortTable(col) {
  const key = REP_SORT_KEYS[col];
  repSortDir[col] = !repSortDir[col];
  repSortCol = col;
  repByCountry.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'string') {
      return repSortDir[col] ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return repSortDir[col] ? va - vb : vb - va;
  });
  document.querySelectorAll('#rep-table-panel thead th').forEach((th, i) => {
    th.classList.toggle('sorted', i === col);
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = i === col ? (repSortDir[col] ? '↑' : '↓') : '↕';
  });
  repRenderTableBody();
}

async function repSaveSnapshot() {
  if (repRows.length === 0) return;
  const btn = document.getElementById('rep-save-btn');
  const status = document.getElementById('rep-save-status');
  btn.disabled = true;
  status.style.color = 'var(--text-light)';
  status.textContent = 'Guardando...';
  try {
    const byCountry = repAggregateByCountry(repRows);
    const global = repGetGlobal(repRows);
    const stored = sessionStorage.getItem(SESSION_KEY);
    const user = stored ? JSON.parse(stored) : null;
    await sbInsert('dt_reportes_ventas', [{
      created_by: user ? user[0] : null,
      rows: repRows,
      by_country: byCountry,
      global: global,
    }]);
    status.style.color = 'var(--green)';
    status.textContent = '✓ Guardado con hora exacta';
    await repLoadHistory();
  } catch (err) {
    status.style.color = 'var(--red)';
    status.textContent = 'Error al guardar, intenta de nuevo';
  } finally {
    btn.disabled = false;
    setTimeout(() => { status.textContent = ''; }, 3000);
  }
}

/* ── Filtro de día para la línea de tiempo ── */
let repDateFilter = 'today'; // 'today' | 'yesterday' | '7d' | 'all' | 'YYYY-MM-DD'

function repLocalDayStart(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

function repDateBoundsFor(filter) {
  if (filter === 'today') {
    const start = repLocalDayStart(0);
    const end = repLocalDayStart(1);
    return { start, end };
  }
  if (filter === 'yesterday') {
    const start = repLocalDayStart(-1);
    const end = repLocalDayStart(0);
    return { start, end };
  }
  if (filter === '7d') {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 7);
    return { start, end };
  }
  if (filter === 'all') return null;
  // filtro = fecha específica 'YYYY-MM-DD'
  const start = new Date(`${filter}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

function repSetDateFilter(value) {
  if (!value) return;
  repDateFilter = value;
  document.querySelectorAll('.rep-date-btn').forEach(b => {
    const active = b.dataset.filter === value;
    b.classList.toggle('btn-primary', active);
    b.classList.toggle('btn-ghost', !active);
  });
  if (['today', 'yesterday', '7d', 'all'].includes(value)) {
    document.getElementById('rep-date-input').value = '';
  } else {
    document.querySelectorAll('.rep-date-btn').forEach(b => {
      b.classList.remove('btn-primary');
      b.classList.add('btn-ghost');
    });
  }
  repLoadHistory();
}

/* Trae snapshots (created_at,by_country,global) para un rango de fecha dado */
async function repFetchSnapshotsForRange(filter) {
  try {
    const bounds = repDateBoundsFor(filter);
    let query = 'select=created_at,by_country,global&order=created_at.asc&limit=2000';
    if (bounds) {
      query += `&created_at=gte.${encodeURIComponent(bounds.start.toISOString())}`;
      query += `&created_at=lt.${encodeURIComponent(bounds.end.toISOString())}`;
    }
    return await sbFetch('dt_reportes_ventas', query);
  } catch (err) {
    console.error('Error cargando snapshots:', err);
    return [];
  }
}

/* Trae el snapshot guardado más reciente (para calcular deltas al generar un reporte) */
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
  const [hist, yHist] = await Promise.all([
    repFetchSnapshotsForRange(repDateFilter),
    repDateFilter === 'today' ? repFetchSnapshotsForRange('yesterday') : Promise.resolve([]),
  ]);
  repHistory = hist;
  repYesterdayHistory = yHist;
  repRenderChart();
}

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
  const fmt = repDateFilter === 'today' || repDateFilter === 'yesterday'
    ? { hour:'2-digit', minute:'2-digit' }
    : { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' };
  return d.toLocaleString('es-PE', fmt);
}

function repColorFor(country, i) {
  return REP_COUNTRY_COLORS[country] || REP_FALLBACK_COLORS[i % REP_FALLBACK_COLORS.length];
}

/* Color de cada barra según el semáforo: rojo <25%, neutro 25-30%, verde 30%+ */
function repBarColor(pct) {
  if (pct === null || pct === undefined) return 'transparent';
  if (pct < 25) return '#f87171';
  if (pct < 30) return 'rgba(100,116,139,.35)';
  return '#4ade80';
}

/* Valor de la serie elegida ('Total' = global, o el nombre de un país) dentro de un snapshot */
function repValueForSeries(snapshot, series) {
  if (!snapshot) return null;
  if (series === 'Total') return snapshot.global ? snapshot.global.approvePct : null;
  const found = (snapshot.by_country || []).find(c => c.country === series);
  return found ? found.approvePct : null;
}

function repRenderChart() {
  const countEl = document.getElementById('rep-snap-count');
  countEl.textContent = `${repHistory.length} snapshot${repHistory.length !== 1 ? 's' : ''} en este rango`;

  const emptyEl = document.getElementById('rep-chart-empty');
  const wrapEl  = document.getElementById('rep-chart-wrap');
  const togglesEl = document.getElementById('rep-chart-toggles');

  if (repHistory.length === 0) {
    const filterLabel = { today:'hoy', yesterday:'ayer', '7d':'los últimos 7 días', all:'el historial' }[repDateFilter]
      || `el ${repDateFilter}`;
    const p = emptyEl.querySelector('p');
    const small = emptyEl.querySelector('small');
    if (p) p.textContent = `No hay snapshots guardados para ${filterLabel}`;
    if (small) small.textContent = 'Prueba con otro rango, o pega datos y guarda un snapshot ahora';
    emptyEl.style.display = 'flex';
    wrapEl.style.display  = 'none';
    togglesEl.innerHTML   = '';
    return;
  }
  emptyEl.style.display = 'none';
  wrapEl.style.display  = 'block';

  const allCountries = [...new Set(repHistory.flatMap(h => (h.by_country || []).map(c => c.country)))];
  if (repChartSeries !== 'Total' && !allCountries.includes(repChartSeries)) repChartSeries = 'Total';
  const showGhost = repDateFilter === 'today' && repYesterdayHistory.length > 0;

  // Pills de selección única — Total o un país a la vez
  togglesEl.innerHTML =
    `<div class="rep-toggle-chip ${repChartSeries === 'Total' ? '' : 'off'}" style="border-color:var(--nav-accent);color:var(--nav-accent)" onclick="repSelectSeries('Total')">Total</div>` +
    allCountries.map((c, i) => {
      const color = repColorFor(c, i);
      const off = repChartSeries === c ? '' : 'off';
      return `<div class="rep-toggle-chip ${off}" style="border-color:${color};color:${color}" onclick="repSelectSeries('${c}')">${countryFlag(c)}${c}</div>`;
    }).join('');

  const labels = repHistory.map(h => repFmtTimestamp(h.created_at));
  const values = repHistory.map(h => {
    const v = repValueForSeries(h, repChartSeries);
    return v !== null && v !== undefined ? Number(v.toFixed(1)) : null;
  });

  const datasets = [{
    type: 'bar',
    label: repChartSeries,
    data: values,
    backgroundColor: values.map(repBarColor),
    borderRadius: 4, borderSkipped: false,
  }];

  let ghostValues = [];
  if (showGhost) {
    ghostValues = repHistory.map(h => {
      const match = repNearestByTimeOfDay(new Date(h.created_at), repYesterdayHistory);
      const v = match ? repValueForSeries(match, repChartSeries) : null;
      return v !== null && v !== undefined ? Number(v.toFixed(1)) : null;
    });
    datasets.push({
      type: 'bar',
      label: 'Ayer (misma hora)',
      data: ghostValues,
      backgroundColor: 'rgba(147,168,157,.35)',
      borderRadius: 4, borderSkipped: false,
    });
  }

  // Techo del eje: REP_CHART_MAX_DEFAULT de base, pero nunca corta una barra real
  const seenValues = [...values, ...ghostValues].filter(v => v !== null && v !== undefined);
  const dataMax = seenValues.length ? Math.max(...seenValues) : 0;
  const axisMax = Math.min(100, Math.max(REP_CHART_MAX_DEFAULT, Math.ceil((dataMax + 5) / 5) * 5));

  // Bandas de referencia del semáforo, superpuestas como líneas
  datasets.push({ type: 'line', label: 'Umbral 30%', data: labels.map(() => 30), borderColor: 'rgba(34,197,94,.45)', borderDash: [4,4], borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0 });
  datasets.push({ type: 'line', label: 'Umbral 25%', data: labels.map(() => 25), borderColor: 'rgba(239,68,68,.45)', borderDash: [4,4], borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0 });

  if (repChartInstance) repChartInstance.destroy();
  repChartInstance = new Chart(document.getElementById('repChart'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { ...chartDefaults.font, boxWidth: 12 } },
        datalabels: {
          display: (ctx) => ctx.datasetIndex === 0 && ctx.dataset.data[ctx.dataIndex] !== null,
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
        y: { grid: { color: CHART_GRID }, ticks: { ...chartDefaults.font, callback: v => v + '%' }, min: 0, max: axisMax }
      }
    }
  });
}

function repSelectSeries(series) {
  repChartSeries = series;
  repRenderChart();
}

async function repInitView() {
  repLoaded = true;
  const isSup = isSupervisor();
  document.getElementById('rep-paste-panel').style.display = isSup ? 'block' : 'none';
  document.getElementById('rep-tl-note').style.display = isSup ? 'none' : 'flex';
  await repLoadCurrentReport();
  repLoadHistory();
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

/* Carga el último reporte guardado y lo muestra como "el reporte actual" para cualquiera que entre */
async function repLoadCurrentReport() {
  const latestTwo = await repFetchLatestTwo();
  if (latestTwo.length === 0) return; // nadie ha guardado nada todavía — se queda el empty state

  const [latest, prev] = latestTwo;
  repPrevSnapshot = prev || null;
  repByCountry = (latest.by_country || []).map(c => ({ ...c }));
  repGlobal = { ...latest.global };

  const prevByCountry = repPrevSnapshot ? (repPrevSnapshot.by_country || []) : [];
  repByCountry.forEach(c => {
    const p = prevByCountry.find(x => x.country === c.country);
    c.deltaPct = p ? c.approvePct - p.approvePct : null;
    c.prevApprovePct = p ? p.approvePct : null;
  });
  repGlobal.deltaPct = repPrevSnapshot ? repGlobal.approvePct - repPrevSnapshot.global.approvePct : null;
  repGlobal.prevApprovePct = repPrevSnapshot ? repPrevSnapshot.global.approvePct : null;

  document.getElementById('rep-empty-state').style.display = 'none';

  const todaySnaps = await repFetchSnapshotsForRange('today');
  repRenderSummary(todaySnaps);
  repRenderKPIs();
  repRenderTableBody();
  repRenderTfoot();

  document.getElementById('rep-table-panel').style.display = 'block';
  repUpdateLastUpdatedLabel(latest.created_at, latest.created_by);
}
