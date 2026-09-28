/* Vista Inicio — widgets de resumen (top operadores, approve 7 días, conteos). */

/* ══════════════════════════════
   INICIO — widgets reales (Top Operadores, Approve 7 días, Conteo GoodDay)
══════════════════════════════ */
let dashLoaded = false;

async function loadDashboard() {
  dashLoaded = true;
  dashLoadTopOps();
  dashLoadApproveWidget();
  dashLoadCountsWidget();
}

function dashGoToOpsCountry(country) {
  setNav(document.getElementById('nav-ops'), 'ops');
  (async () => {
    if (!opsLoaded) await loadOps();
    opsShowCountryDetail(country);
  })();
}

function dashGoToReportes() {
  setNav(document.getElementById('nav-reportes'), 'reportes');
}

function dashGoToGoodDay() {
  setNav(document.getElementById('nav-goodday'), 'goodday');
}

/* ── Widget 1: Top Operadores por Campaña (carrusel tipo publicidad) ── */
let dashTopOpsCountries = []; // [{country, rows}], solo países con datos
let dashTopOpsIndex     = 0;
let dashTopOpsTimer     = null;
const DASH_TOP_OPS_N        = 6;
const DASH_TOP_OPS_INTERVAL = 6000;

async function dashLoadTopOps() {
  try {
    if (!opsLoaded) await loadOps();
    dashBuildTopOpsData();
    dashRenderTopOpsSlide();
    dashResetTopOpsTimer();
  } catch (err) {
    console.error('Error cargando Top Operadores:', err);
  }
}

function dashBuildTopOpsData() {
  dashTopOpsCountries = OPS_STATS_COUNTRIES
    .map(c => ({ country: c, rows: opsGetCountryRows(c).slice(0, DASH_TOP_OPS_N) }))
    .filter(x => x.rows.length > 0);
  if (dashTopOpsIndex >= dashTopOpsCountries.length) dashTopOpsIndex = 0;
}

function dashRenderTopOpsSlide() {
  const wrap = document.getElementById('dash-top-ops-slide');
  const dots = document.getElementById('dash-top-ops-dots');

  if (dashTopOpsCountries.length === 0) {
    wrap.innerHTML = `<div class="gd-state" style="padding:30px">
      <p>Sin datos de Approve Stats todavía</p>
      <small>Sube un Excel en Approve Stats para ver aquí el top de operadores.</small>
    </div>`;
    dots.innerHTML = '';
    return;
  }

  const slide = dashTopOpsCountries[dashTopOpsIndex];
  const color = REP_COUNTRY_COLORS[slide.country] || REP_FALLBACK_COLORS[dashTopOpsIndex % REP_FALLBACK_COLORS.length];

  const rowsHtml = slide.rows.map((r, i) => {
    const ac = approveClass(r.approvePct);
    return `<tr>
      <td style="font-weight:700;color:var(--text-light)">${i + 1}</td>
      <td style="font-weight:600">${r.asesor}<div style="font-size:10px;color:var(--text-light);font-weight:400">${r.operator}</div></td>
      <td>${recTlBadge(r.teamLeader)}</td>
      <td>${gdScheduleBadge(r.horario)}</td>
      <td style="text-align:right">${r.total}</td>
      <td class="${ac}" style="font-weight:700;text-align:right">${r.approvePct !== null ? r.approvePct.toFixed(1) + '%' : '—'}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;color:${color}">
        ${countryFlag(slide.country)}${slide.country}
      </div>
      <button class="btn btn-ghost btn-sm" onclick="dashGoToOpsCountry('${slide.country}')">Ver detalle →</button>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead><tr>
          <th></th><th>Operador</th><th>Team Leader</th><th>Horario</th><th style="text-align:right">Total</th><th style="text-align:right">Approve %</th>
        </tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;

  dots.innerHTML = dashTopOpsCountries.map((s, i) => `<span onclick="dashTopOpsGoto(${i})" style="width:7px;height:7px;border-radius:50%;cursor:pointer;background:${i === dashTopOpsIndex ? 'var(--nav-accent)' : 'var(--border)'};transition:background .2s"></span>`).join('');
}

function dashTopOpsGoto(i) {
  if (dashTopOpsCountries.length === 0) return;
  dashTopOpsIndex = ((i % dashTopOpsCountries.length) + dashTopOpsCountries.length) % dashTopOpsCountries.length;
  dashRenderTopOpsSlide();
  dashResetTopOpsTimer();
}
function dashTopOpsNext() { dashTopOpsGoto(dashTopOpsIndex + 1); }
function dashTopOpsPrev() { dashTopOpsGoto(dashTopOpsIndex - 1); }

/* Barrita que se llena hasta el próximo cambio automático de slide */
function dashStartProgressBar() {
  const fill = document.getElementById('dash-top-ops-progress-fill');
  if (!fill) return;
  fill.style.transition = 'none';
  fill.style.width = '0%';
  void fill.offsetWidth; // fuerza reflow para que el próximo transition se note
  fill.style.transition = `width ${DASH_TOP_OPS_INTERVAL}ms linear`;
  fill.style.width = '100%';
}

function dashResetTopOpsTimer() {
  if (dashTopOpsTimer) clearInterval(dashTopOpsTimer);
  const progressBox = document.getElementById('dash-top-ops-progress');
  if (dashTopOpsCountries.length > 1) {
    progressBox.style.display = 'block';
    dashStartProgressBar();
    dashTopOpsTimer = setInterval(() => {
      dashTopOpsIndex = (dashTopOpsIndex + 1) % dashTopOpsCountries.length;
      dashRenderTopOpsSlide();
      dashStartProgressBar();
    }, DASH_TOP_OPS_INTERVAL);
  } else {
    progressBox.style.display = 'none';
  }
}

/* ── Widget 2: Approve general de CC en los últimos 7 días (datos de Reportes) ──
   Solo se muestra UN punto por día: el último snapshot guardado ese día. */
let dashApproveChartInstance = null;

async function dashLoadApproveWidget() {
  try {
    const [history, latestTwo] = await Promise.all([
      repFetchSnapshotsForRange('7d'),
      repFetchLatestTwo(),
    ]);
    const latest = latestTwo[0] || null;
    dashRenderApproveChart(dashLastSnapshotPerDay(history));
    dashRenderCampaignExtremes(latest);
    dashUpdateApproveTimestamp(latest);
  } catch (err) {
    console.error('Error cargando widget de Approve general:', err);
  }
}

/* Agrupa por día calendario local y se queda solo con el snapshot más reciente de cada día */
function dashLastSnapshotPerDay(history) {
  const byDay = {};
  (history || []).forEach(h => {
    const d = new Date(h.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!byDay[key] || new Date(h.created_at) > new Date(byDay[key].created_at)) byDay[key] = h;
  });
  return Object.keys(byDay).sort().map(k => byDay[k]);
}

function dashUpdateApproveTimestamp(latest) {
  const el = document.getElementById('dash-approve-updated');
  if (!latest) { el.textContent = ''; return; }
  const d = new Date(latest.created_at);
  const fecha = d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const hora = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  el.textContent = `Última actualización: ${fecha} ${hora}`;
}

function dashRenderApproveChart(perDay) {
  const canvas = document.getElementById('dashApproveChart');
  if (dashApproveChartInstance) { dashApproveChartInstance.destroy(); dashApproveChartInstance = null; }

  if (!perDay || perDay.length === 0) {
    canvas.style.display = 'none';
    return;
  }
  canvas.style.display = 'block';

  // Etiqueta = día + hora exacta en que se guardó ese snapshot (el "Approve del día")
  const labels = perDay.map(h => {
    const d = new Date(h.created_at);
    const dayAbbr = d.toLocaleDateString('es-ES', { weekday: 'short' }).replace('.', '');
    const hora = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    return `${dayAbbr.charAt(0).toUpperCase()}${dayAbbr.slice(1)} ${hora}`;
  });
  const values = perDay.map(h => (h.global && h.global.approvePct !== undefined) ? Number(h.global.approvePct.toFixed(1)) : null);

  const seen = values.filter(v => v !== null && v !== undefined);
  const dataMax = seen.length ? Math.max(...seen) : 0;
  const axisMax = Math.min(100, Math.max(REP_CHART_MAX_DEFAULT, Math.ceil((dataMax + 5) / 5) * 5));

  dashApproveChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Approve % del día',
        data: values,
        backgroundColor: values.map(repBarColor),
        borderRadius: 4, borderSkipped: false,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        datalabels: {
          display: true,
          formatter: v => v !== null && v !== undefined ? `${v}%` : '',
          color: '#fff', textStrokeColor: 'rgba(0,0,0,.55)', textStrokeWidth: 3,
          font: { family: "'Lexend', sans-serif", weight: '700', size: 11 },
          anchor: 'center', align: 'center',
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { ...chartDefaults.font, maxRotation: 0, autoSkip: true, maxTicksLimit: 7 } },
        y: { grid: { color: CHART_GRID }, ticks: { ...chartDefaults.font, callback: v => v + '%' }, min: 0, max: axisMax },
      },
    },
  });
}

function dashCampaignCardHTML(label, c) {
  const cls = repApproveClass(c.approvePct);
  return `
    <div style="margin-bottom:14px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div style="font-size:12px;color:var(--text-light)">${label}</div>
        <div style="display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700">
          ${countryFlag(c.country)}${c.country}
          <span class="rep-approve-badge ${cls}">${repFmtPct(c.approvePct)}</span>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table>
          <thead><tr>
            <th>Leads</th><th>New</th><th>Recall</th><th>No answer</th><th>Approved</th><th>%Approve</th><th>Reject</th><th>Trash</th>
          </tr></thead>
          <tbody><tr>
            <td>${c.total.toLocaleString('es-PE')}</td>
            <td style="color:var(--text-light)">${c.new}</td>
            <td style="color:var(--text-light)">${c.recall}</td>
            <td style="color:var(--text-light)">${c.noAnswer}</td>
            <td>${c.approved}</td>
            <td class="${cls}" style="font-weight:700">${repFmtPct(c.approvePct)}</td>
            <td style="color:var(--text-light)">${c.reject}</td>
            <td style="color:var(--text-light)">${c.trash}</td>
          </tr></tbody>
        </table>
      </div>
    </div>`;
}

function dashRenderCampaignExtremes(latest) {
  const box = document.getElementById('dash-lowest-campaign');
  const candidates = latest ? (latest.by_country || []).filter(c => c.total > 0) : [];

  if (candidates.length === 0) {
    box.innerHTML = `<div class="gd-state" style="padding:20px"><p>Todavía no hay reportes guardados</p></div>`;
    return;
  }

  const lowest  = candidates.reduce((min, c) => c.approvePct < min.approvePct ? c : min, candidates[0]);
  const highest = candidates.reduce((max, c) => c.approvePct > max.approvePct ? c : max, candidates[0]);

  box.innerHTML = dashCampaignCardHTML('📉 Campaña más baja ahora mismo', lowest)
    + (highest.country !== lowest.country ? dashCampaignCardHTML('📈 Campaña más alta ahora mismo', highest) : '');
}

/* ── Widget 3: Conteo de OPs y Conteo de Descanso (datos de GoodDay / dt_dis) ── */
let dashRestByPais = {}; // { pais: { diaDescanso: cantidad } }

async function dashLoadCountsWidget() {
  try {
    const data = await sbFetch('dt_dis', 'select=PEROP1AM,PAIS,EMPRESA,HORARIO,DESCANSO');
    dashRenderOpsCount(data);
    dashBuildRestData(data);
    dashPopulateRestFilter();
    dashRenderRestCount();
  } catch (err) {
    console.error('Error cargando conteo de OPs/Descanso:', err);
  }
}

function dashCountBy(rows, key) {
  const map = {};
  rows.forEach(r => {
    const v = (r[key] || '').trim() || 'Sin dato';
    map[v] = (map[v] || 0) + 1;
  });
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

function dashCountTableHTML(headerLabel, entries, badgeFn) {
  return `
    <table style="margin-bottom:16px">
      <thead><tr><th>${headerLabel}</th><th style="text-align:right">Cantidad</th></tr></thead>
      <tbody>
        ${entries.map(([label, count]) => `<tr><td>${badgeFn ? badgeFn(label) : label}</td><td style="text-align:right;font-weight:700">${count}</td></tr>`).join('')}
      </tbody>
    </table>`;
}

function dashRenderOpsCount(rows) {
  const body = document.getElementById('dash-ops-count-body');
  const total = rows.length;
  const byPais    = dashCountBy(rows, 'PAIS');
  const byEmpresa = dashCountBy(rows, 'EMPRESA');
  const byHorario = dashCountBy(rows, 'HORARIO');

  body.innerHTML = `
    <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:14px">
      <div style="font-size:28px;font-weight:800;color:var(--nav-accent)">${total}</div>
      <div style="font-size:12px;color:var(--text-light)">OPs totales en la empresa</div>
    </div>
    ${dashCountTableHTML('Campaña / País', byPais, gdCountryBadge)}
    ${dashCountTableHTML('Empresa', byEmpresa, gdEmpresaBadge)}
    ${dashCountTableHTML('Horario', byHorario, gdScheduleBadge)}`;
}

/* Nota: "turno" se interpreta aquí como el día de descanso (columna DESCANSO de dt_dis) —
   cada país muestra cuántos OPs descansan cada día. Se filtra por campaña porque
   mostrar los 8 países a la vez era demasiada información para un widget de Inicio. */
function dashBuildRestData(rows) {
  dashRestByPais = {};
  rows.forEach(r => {
    const pais = (r.PAIS || '').trim() || 'Sin dato';
    const descanso = (r.DESCANSO || '').trim();
    if (!descanso || descanso.toUpperCase() === 'EMPTY') return;
    if (!dashRestByPais[pais]) dashRestByPais[pais] = {};
    dashRestByPais[pais][descanso] = (dashRestByPais[pais][descanso] || 0) + 1;
  });
}

function dashPopulateRestFilter() {
  const sel = document.getElementById('dash-rest-country-filter');
  const prev = sel.value;
  const paisEntries = Object.entries(dashRestByPais).sort((a, b) => {
    const totalA = Object.values(a[1]).reduce((s, n) => s + n, 0);
    const totalB = Object.values(b[1]).reduce((s, n) => s + n, 0);
    return totalB - totalA;
  });
  if (paisEntries.length === 0) {
    sel.innerHTML = '<option value="">Sin datos</option>';
    return;
  }
  sel.innerHTML = paisEntries.map(([pais]) => `<option value="${pais}">${pais}</option>`).join('');
  if (prev && dashRestByPais[prev]) sel.value = prev;
}

const DASH_WEEKDAY_ORDER = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
function dashNormalizeDay(day) {
  return (day || '').toUpperCase().trim()
    .replace('É', 'E').replace('Á', 'A').replace('Í', 'I').replace('Ó', 'O').replace('Ú', 'U');
}
function dashWeekdayRank(day) {
  const idx = DASH_WEEKDAY_ORDER.indexOf(dashNormalizeDay(day));
  return idx === -1 ? 99 : idx;
}

function dashRenderRestCount() {
  const body = document.getElementById('dash-rest-count-body');
  const sel = document.getElementById('dash-rest-country-filter');
  const pais = sel.value;
  const days = dashRestByPais[pais];

  if (!pais || !days) {
    body.innerHTML = `<div class="gd-state" style="padding:20px"><p>Sin datos de descanso todavía</p></div>`;
    return;
  }

  const dayEntries = Object.entries(days).sort((a, b) => dashWeekdayRank(a[0]) - dashWeekdayRank(b[0]));
  const total = dayEntries.reduce((s, [, n]) => s + n, 0);

  body.innerHTML = `
    <table>
      <thead><tr><th>Día</th><th style="text-align:right">Cantidad</th></tr></thead>
      <tbody>
        ${dayEntries.map(([day, count]) => `<tr><td>${gdDayBadge(day)}</td><td style="text-align:right;font-weight:700">${count}</td></tr>`).join('')}
      </tbody>
      <tfoot><tr><td style="font-weight:700">Total</td><td style="text-align:right;font-weight:700">${total}</td></tr></tfoot>
    </table>`;
}
