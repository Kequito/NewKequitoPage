/* Vista Ventas por Fuera — ventas registradas "por fuera" en 4 hojas de Google (una por campaña),
   leídas EN VIVO desde el navegador (core/sheets.js), cruzadas con la distribución actual (dt_dis).

   Reglas (acordadas con el equipo):
   · Venta = fila con "ORDEN CREADA" marcada (TRUE / VERDADERO).
   · Cada "ID ORDEN" cuenta UNA sola vez por hoja (a veces la misma orden se registra dos veces).
   · Solo cuentan los OPs que están HOY en la distribución; las ventas de otros no se muestran.
   · Solo el mes actual y el anterior, separados por la "Marca temporal" (d/m/aaaa).
   · Las hojas se emparejan con el OP por el NÚMERO del PEROP1AM (la hoja trae solo "41328").
   Los links se cambian en Actualización de Data (dt_data_links: vf_mexico, vf_peru, vf_paraguay, vf_uruguay);
   si no hay uno guardado se usa el de por defecto. Sirve el link "pubhtml" tal cual (errCsvUrl lo pasa a CSV). */

const VF_BASE_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRiTBUc_Q0e9Zx_j0dPsxbJs1_6K077H4UE_N3XZDkUx_ZYeSd0XYMJ_5UIzXx_6yYLY2adQCNy-vmz/pubhtml';

const VF_SOURCES = [
  { key: 'mexico',   label: 'México',   code: 'MX', country: 'Mexico',   linkKey: 'vf_mexico',   defaultUrl: `${VF_BASE_URL}?gid=0&single=true` },
  { key: 'peru',     label: 'Perú',     code: 'PE', country: 'Peru',     linkKey: 'vf_peru',     defaultUrl: `${VF_BASE_URL}?gid=491551479&single=true` },
  { key: 'paraguay', label: 'Paraguay', code: 'PY', country: 'Paraguay', linkKey: 'vf_paraguay', defaultUrl: `${VF_BASE_URL}?gid=1841321863&single=true` },
  { key: 'uruguay',  label: 'Uruguay',  code: 'UY', country: 'Uruguay',  linkKey: 'vf_uruguay',  defaultUrl: `${VF_BASE_URL}?gid=566962497&single=true` },
];

/* Valores de "ORDEN CREADA" que cuentan como venta (ya normalizados con errNorm: mayúsculas, sin tildes) */
const VF_CREATED_VALUES = ['TRUE', 'VERDADERO', 'SI', 'X'];

let vfLoaded = false;
let vfBusy = false;
let vfSales = null;        // [{ source, num, month, day, id }] — ventas válidas del mes actual y del anterior (todas, sin cruzar)
let vfCalCampaign = '';    // calendario: '' = todas las campañas, o la key de una (mexico, peru…)
let vfCalDay = null;       // día elegido en el calendario (muestra su detalle), o null
let vfOps = [];            // OPs de la distribución: [{ num, perop, asesor, tl, pais }]
let vfStatus = {};         // source → { ok, count, dup, error }
let vfFetchedAt = null;
let vfMonth = 'current';   // 'current' | 'prev'
let vfOpSort = { key: 'total', dir: -1 };

/* ══════════════════════════════
   MESES
══════════════════════════════ */
function vfMonthDate(offset) { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + offset, 1); }
function vfMonthKey(offset) { const d = vfMonthDate(offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }
function vfSelectedOffset() { return vfMonth === 'prev' ? -1 : 0; }
function vfMonthLabel(offset) {
  const s = vfMonthDate(offset).toLocaleDateString('es-PE', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function vfSetMonth(month) {
  vfMonth = month === 'prev' ? 'prev' : 'current';
  vfCalDay = null;   // el día elegido era del otro mes
  vfSyncMonthButtons();
  vfRenderAll();
}

function vfSyncMonthButtons() {
  document.querySelectorAll('.vf-month-btn').forEach(b => {
    const off = b.dataset.month === 'prev' ? -1 : 0;
    b.textContent = `${vfMonthLabel(off)}${off === 0 ? ' (en curso)' : ''}`;
    b.classList.toggle('active', b.dataset.month === vfMonth);
    b.setAttribute('aria-selected', String(b.dataset.month === vfMonth));
  });
  const today = new Date();
  document.getElementById('vf-month-note').textContent = vfMonth === 'current'
    ? `del 1 al ${today.getDate()} — el mes todavía está en curso`
    : 'mes completo';
}

/* ══════════════════════════════
   LECTURA DE LAS HOJAS
══════════════════════════════ */
function vfSourceUrl(src) {
  const saved = (typeof dataLinksMap !== 'undefined') && dataLinksMap[src.linkKey];
  return (saved && saved.url) || src.defaultUrl;
}

async function vfFetchLinks() {
  try {
    const keys = VF_SOURCES.map(s => s.linkKey).join(',');
    const rows = await sbFetch('dt_data_links', `select=*&section_key=in.(${keys})`);
    VF_SOURCES.forEach(s => { delete dataLinksMap[s.linkKey]; });
    (rows || []).forEach(r => { dataLinksMap[r.section_key] = r; });
  } catch (err) {
    console.warn('Ventas por Fuera: no se pudieron leer los links guardados, se usan los de por defecto', err);
  }
}

/* "31/1/2026 8:54:39" o "6/3/2026" → { month: "2026-01", day: 31 } (o null) */
function vfRowDate(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const day = Number(m[1]), month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month: `${m[3]}-${String(month).padStart(2, '0')}`, day };
}

/* Una hoja → ventas válidas de los 2 meses que se muestran. Las columnas se buscan por NOMBRE:
   cada hoja tiene un orden distinto (Perú y Uruguay traen PRODUCTO, México no, etc.). */
function vfParseTable(src, table) {
  const h = table.findIndex((r, i) => i < 10 && (r || []).some(c => errNorm(c) === 'ID ORDEN'));
  if (h < 0) throw new Error(`La hoja de ${src.label} no tiene la columna "ID ORDEN". ¿Cambió el formato?`);
  const header = table[h];
  const col = test => header.findIndex(c => test(errNorm(c)));
  const C = {
    date: col(n => n === 'MARCA TEMPORAL'),
    id: col(n => n === 'ID ORDEN'),
    user: col(n => n.startsWith('USUARIO')),
    created: col(n => n === 'ORDEN CREADA'),
  };
  const missing = Object.entries({ date: '"Marca temporal"', user: '"USUARIO (PEROP1AM)"', created: '"ORDEN CREADA"' })
    .filter(([k]) => C[k] < 0).map(([, name]) => name);
  if (missing.length) throw new Error(`La hoja de ${src.label} no tiene la columna ${missing.join(' ni ')}. ¿Cambió el formato?`);

  const months = new Set([vfMonthKey(0), vfMonthKey(-1)]);
  const seen = new Set();
  const sales = [];
  let dup = 0;
  table.slice(h + 1).forEach(r => {
    const id = String(r[C.id] ?? '').trim();
    if (!id || !VF_CREATED_VALUES.includes(errNorm(r[C.created]))) return;
    if (seen.has(id)) { dup++; return; }          // misma orden registrada otra vez: cuenta una sola vez
    seen.add(id);
    const date = vfRowDate(r[C.date]);
    if (!date || !months.has(date.month)) return;
    const num = sheetOperatorNumber(r[C.user]);
    if (num) sales.push({ source: src.key, num, month: date.month, day: date.day, id });
  });
  return { sales, dup };
}

async function vfInitView() {
  vfLoaded = true;
  vfSyncMonthButtons();
  await vfLoad();
}

/* silent = auto-refresh: sin "Cargando…", conserva filtros y mes */
async function vfLoad(silent = false) {
  if (vfBusy) return;
  vfBusy = true;
  const btn = document.getElementById('vf-refresh-btn');
  const errBox = document.getElementById('vf-error');
  btn.disabled = true;
  btn.classList.add('ol-spin');
  if (!silent) errBox.hidden = true;
  if (!vfSales) document.getElementById('vf-loading').hidden = false;

  try {
    await vfFetchLinks();
    const [dis, ...results] = await Promise.all([
      sbFetch('dt_dis', 'select=PEROP1AM,ASESORES,TEAMLEADER,PAIS').catch(() => {
        throw new Error('No se pudo leer la distribución (Equipos 360) desde Supabase. Intenta de nuevo o vuelve a iniciar sesión.');
      }),
      // Si una hoja falla, las otras igual se usan (el aviso de arriba dice cuál falló)
      ...VF_SOURCES.map(src => sheetFetchCsv(errCsvUrl(vfSourceUrl(src)), `ventas por fuera de ${src.label}`)
        .then(table => ({ ok: true, ...vfParseTable(src, table) }))
        .catch(error => { console.error(`Ventas por Fuera: ${src.label}`, error); return { ok: false, error }; })),
    ]);

    // OPs de la distribución, sin repetir el mismo número de operador
    const seen = new Set();
    vfOps = [];
    (dis || []).forEach(d => {
      const num = sheetOperatorNumber(d.PEROP1AM);
      if (!num || seen.has(num)) return;
      seen.add(num);
      vfOps.push({ num, perop: (d.PEROP1AM || '').trim(), asesor: (d.ASESORES || '').trim() || d.PEROP1AM, tl: (d.TEAMLEADER || '').trim() || '—', pais: (d.PAIS || '').trim() });
    });

    vfStatus = {};
    vfSales = [];
    results.forEach((r, i) => {
      const src = VF_SOURCES[i];
      vfStatus[src.key] = r.ok ? { ok: true, count: r.sales.length, dup: r.dup } : { ok: false, error: r.error };
      if (r.ok) vfSales.push(...r.sales);
    });
    vfFetchedAt = new Date().toISOString();
    errBox.hidden = true;
    document.getElementById('vf-loading').hidden = true;
    document.getElementById('vf-content').hidden = false;
    vfRenderStatus();
    vfPopulateTlFilter();
    vfRenderAll();
  } catch (err) {
    console.error('Error cargando Ventas por Fuera:', err);
    errBox.textContent = (err && err.message) ? err.message : 'No se pudo cargar la información, intenta de nuevo.';
    errBox.hidden = false;
    if (!vfSales) document.getElementById('vf-loading').hidden = true;
  } finally {
    vfBusy = false;
    btn.disabled = false;
    btn.classList.remove('ol-spin');
  }
}

/* Tras cambiar un link en Actualización de Data: si la sección ya se abrió, se vuelve a leer con el link nuevo */
function vfOnLinkChanged(sectionKey) {
  if (vfLoaded && VF_SOURCES.some(s => s.linkKey === sectionKey)) vfLoad(true);
}

function vfRenderStatus() {
  const warn = document.getElementById('vf-warn');
  const failed = VF_SOURCES.filter(s => vfStatus[s.key] && !vfStatus[s.key].ok);
  warn.hidden = failed.length === 0;
  warn.textContent = failed.length === VF_SOURCES.length ? '⚠ No se pudo leer ninguna hoja' : `⚠ Sin datos de: ${failed.map(s => s.label).join(', ')}`;
  warn.title = failed.map(s => `${s.label}: ${(vfStatus[s.key].error && vfStatus[s.key].error.message) || 'no disponible'}`).join('\n');
  vfRenderUpdated();
}

function vfRenderUpdated() {
  const el = document.getElementById('vf-updated');
  el.textContent = vfFetchedAt ? `Actualizado ${repTimeAgo(vfFetchedAt)}` : '';
}
// El "hace X minutos" se mantiene al día solo mientras se mira la sección
setInterval(() => { if (typeof currentPage !== 'undefined' && currentPage === 'ventasfuera' && vfFetchedAt) vfRenderUpdated(); }, 30 * 1000);

/* ══════════════════════════════
   CÁLCULOS — mes elegido, cruzado con la distribución
══════════════════════════════ */
function vfEmptyCounts() {
  const c = {};
  VF_SOURCES.forEach(s => { c[s.key] = 0; });
  return c;
}

/* Todos los OPs de la distribución con sus ventas del mes elegido */
function vfBuildOps() {
  const month = vfMonthKey(vfSelectedOffset());
  const byNum = new Map(vfOps.map(o => [o.num, { ...o, counts: vfEmptyCounts(), total: 0 }]));
  (vfSales || []).forEach(s => {
    if (s.month !== month) return;
    const o = byNum.get(s.num);
    if (!o) return;                  // OP que ya no está en la distribución: no se muestra
    o.counts[s.source]++;
    o.total++;
  });
  return [...byNum.values()];
}

function vfBuildTLs(ops) {
  const map = new Map();
  ops.forEach(o => {
    if (o.tl === '—') return;
    const t = map.get(o.tl) || { tl: o.tl, ops: 0, withSales: 0, counts: vfEmptyCounts(), total: 0 };
    t.ops++;
    if (o.total > 0) t.withSales++;
    VF_SOURCES.forEach(s => { t.counts[s.key] += o.counts[s.key]; });
    t.total += o.total;
    map.set(o.tl, t);
  });
  return [...map.values()].sort((a, b) => (b.total - a.total) || a.tl.localeCompare(b.tl));
}

function vfSelectedTl() { return document.getElementById('vf-f-tl').value; }

/* ══════════════════════════════
   RENDER
══════════════════════════════ */
function vfPopulateTlFilter() {
  const sel = document.getElementById('vf-f-tl');
  const prev = sel.value;
  const tls = [...new Set(vfOps.map(o => o.tl).filter(t => t && t !== '—'))].sort();
  sel.innerHTML = '<option value="">Todos</option>' + tls.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  if (prev && tls.includes(prev)) sel.value = prev;
}

function vfClearTl() {
  document.getElementById('vf-f-tl').value = '';
  vfRenderAll();
}

function vfPickTl(tl) {
  const sel = document.getElementById('vf-f-tl');
  sel.value = sel.value === tl ? '' : tl;   // clic otra vez en el mismo = ver todos
  vfRenderAll();
  document.getElementById('vf-op-table').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function vfRenderAll() {
  if (!vfSales) return;
  const tl = vfSelectedTl();
  document.getElementById('vf-pill-tl').classList.toggle('active', !!tl);
  const all = vfBuildOps();
  const scope = tl ? all.filter(o => o.tl === tl) : all;
  vfRenderKPIs(scope, tl);
  vfRenderCampaigns(scope);
  vfRenderCalendar();
  vfRenderTLs(vfBuildTLs(all), tl);
  vfRenderOps();
}

function vfRenderKPIs(scope, tl) {
  const total = scope.reduce((s, o) => s + o.total, 0);
  const withSales = scope.filter(o => o.total > 0);
  const best = [...withSales].sort((a, b) => b.total - a.total)[0];
  const who = tl ? `equipo de ${escapeHtml(tl)}` : 'toda la distribución';
  document.getElementById('vf-kpis').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">Ventas por fuera</span></div>
      <div class="kpi-value ol-kpi-green">${total.toLocaleString('es-PE')}</div>
      <span class="kpi-sub">${vfMonthLabel(vfSelectedOffset())} · ${who}</span>
    </div>
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">OPs con ventas</span></div>
      <div class="kpi-value">${withSales.length} <span class="leads-kpi-of">de ${scope.length}</span></div>
      <span class="kpi-sub">${scope.length ? Math.round((withSales.length / scope.length) * 100) : 0}% de los OPs tiene al menos una</span>
    </div>
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">Promedio por OP</span></div>
      <div class="kpi-value">${withSales.length ? (total / withSales.length).toFixed(1) : '0'}</div>
      <span class="kpi-sub">entre los que tienen ventas</span>
    </div>
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">Más ventas del mes</span></div>
      <div class="kpi-value vf-kpi-name" title="${escapeHtml(best ? best.asesor : '')}">${best ? escapeHtml(best.asesor) : '—'}</div>
      <span class="kpi-sub">${best ? `${best.total} venta${best.total === 1 ? '' : 's'} · ${escapeHtml(best.tl)}` : 'todavía nadie'}</span>
    </div>`;
}

function vfRenderCampaigns(scope) {
  const totals = vfEmptyCounts();
  scope.forEach(o => VF_SOURCES.forEach(s => { totals[s.key] += o.counts[s.key]; }));
  const sum = Object.values(totals).reduce((a, b) => a + b, 0);
  document.getElementById('vf-campaigns').innerHTML = VF_SOURCES.map((s, i) => {
    const st = vfStatus[s.key] || {};
    const color = REP_COUNTRY_COLORS[s.country] || REP_FALLBACK_COLORS[i % REP_FALLBACK_COLORS.length];
    return `<div class="vf-camp ${st.ok === false ? 'vf-camp--off' : ''}" style="--c:${color}" title="${st.ok === false ? escapeHtml((st.error && st.error.message) || 'No se pudo leer la hoja') : `${st.dup || 0} registro(s) repetido(s) en la hoja, contados una vez`}">
      <span class="vf-camp-name">${countryFlag(s.country)}${escapeHtml(s.label)}</span>
      <span class="vf-camp-num">${st.ok === false ? '—' : totals[s.key].toLocaleString('es-PE')}</span>
      <span class="vf-camp-bar"><i style="width:${sum ? ((totals[s.key] / sum) * 100).toFixed(1) : 0}%"></i></span>
      <span class="vf-camp-sub">${st.ok === false ? 'hoja no disponible' : `${sum ? Math.round((totals[s.key] / sum) * 100) : 0}% del total`}</span>
    </div>`;
  }).join('');
}

/* Encabezado de columnas por campaña (con bandera). short = código de 2 letras (tablas de la página, que tienen
   muchas columnas); la imagen exportada tiene ancho de sobra y usa el nombre completo. */
function vfCampaignHeads(short = false) {
  return VF_SOURCES.map(s => `<th class="num vf-th-camp" title="${escapeHtml(s.label)}">${countryFlag(s.country)}${escapeHtml(short ? s.code : s.label)}</th>`).join('');
}
function vfCampaignCells(counts) {
  return VF_SOURCES.map(s => `<td class="num ${counts[s.key] ? '' : 'vf-zero'}">${counts[s.key] || '·'}</td>`).join('');
}
/* Verde más intenso mientras más ventas (relativo al máximo de la lista) */
function vfHeat(n, max) {
  return n > 0 ? ` style="background:rgba(34,197,94,${(0.1 + (n / Math.max(1, max)) * 0.4).toFixed(2)})"` : '';
}

function vfRenderTLs(tls, selected) {
  document.getElementById('vf-tl-thead').innerHTML = `<tr><th>#</th><th>Team Leader</th><th class="num">OPs con ventas</th>${vfCampaignHeads(true)}<th class="num">Total</th><th class="num">Prom. por OP</th></tr>`;
  const max = Math.max(0, ...tls.map(t => t.total));
  document.getElementById('vf-tl-tbody').innerHTML = tls.map((t, i) => `
    <tr class="eq-row ${t.tl === selected ? 'vf-row-on' : ''}" onclick="vfPickTl(${jsArg(t.tl)})" title="Ver solo el equipo de ${escapeHtml(t.tl)}">
      <td class="dash-rank">${i < 3 && t.total ? TL_MEDALS[i] : i + 1}</td>
      <td>${recTlBadge(t.tl)}</td>
      <td class="num">${t.withSales}<span class="txt-light">/${t.ops}</span></td>
      ${vfCampaignCells(t.counts)}
      <td class="num vf-total"${vfHeat(t.total, max)}>${t.total}</td>
      <td class="num">${t.ops ? (t.total / t.ops).toFixed(1) : '0'}</td>
    </tr>`).join('') || '<tr><td colspan="9" class="td-empty">La distribución no tiene Team Leaders</td></tr>';
  const sumC = vfEmptyCounts();
  tls.forEach(t => VF_SOURCES.forEach(s => { sumC[s.key] += t.counts[s.key]; }));
  const ops = tls.reduce((s, t) => s + t.ops, 0), withS = tls.reduce((s, t) => s + t.withSales, 0), total = tls.reduce((s, t) => s + t.total, 0);
  document.getElementById('vf-tl-tfoot').innerHTML = tls.length
    ? `<tr><td></td><td>Total</td><td class="num">${withS}<span class="txt-light">/${ops}</span></td>${VF_SOURCES.map(s => `<td class="num">${sumC[s.key]}</td>`).join('')}<td class="num">${total}</td><td class="num">${ops ? (total / ops).toFixed(1) : '0'}</td></tr>`
    : '';
}

const VF_OP_COLS = [
  { key: 'asesor', label: 'Operador' },
  { key: 'tl', label: 'Team Leader' },
  { key: 'pais', label: 'Campaña' },
  ...VF_SOURCES.map(s => ({ key: `c:${s.key}`, label: s.label, num: true, camp: s })),
  { key: 'total', label: 'Total', num: true },
];

function vfSortOps(key) {
  const col = VF_OP_COLS.find(c => c.key === key);
  vfOpSort = vfOpSort.key === key ? { key, dir: -vfOpSort.dir } : { key, dir: col && col.num ? -1 : 1 };
  vfRenderOps();
}

/* OPs del filtro actual, ordenados (la tabla de la página y la imagen usan exactamente esta lista) */
function vfFilteredOps({ includeZero, search = '' } = {}) {
  const tl = vfSelectedTl();
  const q = search.trim().toLowerCase();
  const val = (o, key) => key.startsWith('c:') ? o.counts[key.slice(2)] : o[key];
  const { key, dir } = vfOpSort;
  return vfBuildOps()
    .filter(o => (!tl || o.tl === tl) && (includeZero || o.total > 0) && (!q || `${o.asesor} ${o.perop}`.toLowerCase().includes(q)))
    .sort((a, b) => {
      const va = val(a, key), vb = val(b, key);
      const c = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return (c * dir) || (b.total - a.total) || a.asesor.localeCompare(b.asesor);
    });
}

function vfRenderOps() {
  if (!vfSales) return;
  const search = document.getElementById('vf-search').value;
  document.getElementById('vf-search').closest('.gd-search-wrap').classList.toggle('active', !!search.trim());
  const rows = vfFilteredOps({ includeZero: document.getElementById('vf-show-zero').checked, search });
  const { key, dir } = vfOpSort;
  document.getElementById('vf-op-thead').innerHTML = `<tr><th>#</th>${VF_OP_COLS.map(c => {
    const on = c.key === key;
    // Campañas con bandera + código corto (MX, PE…): la tabla tiene muchas columnas y así cabe sin cortar "Total"
    const label = c.camp ? `${countryFlag(c.camp.country)}${escapeHtml(c.camp.code)}` : escapeHtml(c.label);
    return `<th class="${on ? 'sorted' : ''} ${c.num ? 'num' : ''}" onclick="vfSortOps('${c.key}')" title="${escapeHtml(c.label)}">${label} <span class="sort-icon">${on ? (dir > 0 ? '↑' : '↓') : '↕'}</span></th>`;
  }).join('')}</tr>`;
  document.getElementById('vf-op-count').textContent = `(${rows.length})`;
  const table = document.getElementById('vf-op-table');
  const empty = document.getElementById('vf-op-empty');
  table.hidden = rows.length === 0;
  empty.hidden = rows.length > 0;
  document.getElementById('vf-op-tbody').innerHTML = vfOpRowsHTML(rows);
}

function vfOpRowsHTML(rows) {
  const max = Math.max(0, ...rows.map(o => o.total));
  return rows.map((o, i) => `<tr class="${o.total ? '' : 'ol-inactive'}">
    <td class="dash-rank">${i + 1}</td>
    <td><div class="dash-op-name">${escapeHtml(o.asesor)}</div><div class="dash-op-code">${escapeHtml(o.perop)}</div></td>
    <td class="nowrap">${recTlBadge(o.tl)}</td>
    <td class="nowrap">${o.pais ? `${countryFlag(o.pais)}${escapeHtml(o.pais)}` : '<span class="txt-light">—</span>'}</td>
    ${vfCampaignCells(o.counts)}
    <td class="num vf-total"${vfHeat(o.total, max)}>${o.total}</td>
  </tr>`).join('');
}

/* ══════════════════════════════
   CALENDARIO — ventas de cada día del mes elegido
   Mismo alcance que el resto de la sección (OPs de la distribución + filtro de Team Leader),
   más su propio filtro de campaña. Clic en un día = detalle de quién vendió ese día.
══════════════════════════════ */
const VF_WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function vfColor(src, i = 0) { return REP_COUNTRY_COLORS[src.country] || REP_FALLBACK_COLORS[i % REP_FALLBACK_COLORS.length]; }

function vfDaysInMonth(offset) {
  const d = vfMonthDate(offset);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/* Ventas de cada día (1..fin de mes) con su detalle por campaña y por OP */
function vfDailyData() {
  const offset = vfSelectedOffset();
  const month = vfMonthKey(offset);
  const tl = vfSelectedTl();
  const opsByNum = new Map(vfOps.filter(o => !tl || o.tl === tl).map(o => [o.num, o]));
  const days = vfDaysInMonth(offset);
  const data = Array.from({ length: days + 1 }, () => ({ total: 0, counts: vfEmptyCounts(), ops: new Map() }));
  (vfSales || []).forEach(s => {
    if (s.month !== month || !opsByNum.has(s.num)) return;
    if (vfCalCampaign && s.source !== vfCalCampaign) return;
    const d = data[s.day];
    if (!d || s.day < 1) return;             // fecha imposible en la hoja (ej. 31/9): se ignora
    d.total++;
    d.counts[s.source]++;
    const op = d.ops.get(s.num) || { op: opsByNum.get(s.num), counts: vfEmptyCounts(), total: 0 };
    op.counts[s.source]++;
    op.total++;
    d.ops.set(s.num, op);
  });
  // Días que ya pasaron: en el mes en curso, hasta hoy; en el anterior, todos
  const lastDay = offset === 0 ? new Date().getDate() : days;
  return { offset, days, data, lastDay };
}

function vfDayLabel(offset, day, withWeekday = true) {
  const base = vfMonthDate(offset);
  const s = new Date(base.getFullYear(), base.getMonth(), day)
    .toLocaleDateString('es-PE', withWeekday ? { weekday: 'long', day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* La cuadrícula. interactive = en la página (días clicables); false = para la imagen exportada */
function vfCalendarHTML(cal, interactive) {
  const lead = (vfMonthDate(cal.offset).getDay() + 6) % 7;   // casillas vacías antes del día 1 (semana empieza el lunes)
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
      !future && !x.total ? 'is-zero' : '', interactive && vfCalDay === d ? 'is-on' : ''].join(' ');
    const alpha = x.total ? (0.1 + (x.total / max) * 0.55).toFixed(2) : '0';
    const bar = x.total
      ? `<span class="vf-cal-bar">${VF_SOURCES.map((s, i) => x.counts[s.key] ? `<i style="flex:${x.counts[s.key]};background:${vfColor(s, i)}"></i>` : '').join('')}</span>`
      : '<span class="vf-cal-bar"></span>';
    const tip = future ? 'Todavía no llega este día'
      : x.total ? `${vfDayLabel(cal.offset, d)}: ${x.total} venta${x.total === 1 ? '' : 's'} — ${VF_SOURCES.filter(s => x.counts[s.key]).map(s => `${s.label} ${x.counts[s.key]}`).join(' · ')}`
      : `${vfDayLabel(cal.offset, d)}: sin ventas`;
    const inner = `<span class="vf-cal-n">${d}${isToday ? '<small>hoy</small>' : ''}</span>
      <span class="vf-cal-v">${future ? '' : (x.total ? x.total.toLocaleString('es-PE') : '—')}</span>${future ? '' : bar}`;
    return interactive && !future
      ? `<button type="button" class="${cls}" style="--a:${alpha}" onclick="vfPickDay(${d})" title="${escapeHtml(tip)}">${inner}</button>`
      : `<div class="${cls}" style="--a:${alpha}" title="${escapeHtml(tip)}">${inner}</div>`;
  };

  let html = `<div class="vf-cal-head">${VF_WEEKDAYS.map((w, i) => `<span class="${i >= 5 ? 'is-weekend' : ''}">${w}</span>`).join('')}<span class="vf-cal-weekcol">Semana</span></div>`;
  for (let w = 0; w < cells.length; w += 7) {
    const week = cells.slice(w, w + 7);
    const weekTotal = week.reduce((s, d) => s + (d ? cal.data[d].total : 0), 0);
    const hasPast = week.some(d => d && d <= cal.lastDay);
    html += `<div class="vf-cal-week">${week.map(dayCell).join('')}
      <div class="vf-cal-weektotal ${hasPast ? '' : 'is-future'}"><span>${hasPast ? weekTotal.toLocaleString('es-PE') : ''}</span>${hasPast ? '<small>ventas</small>' : ''}</div></div>`;
  }
  return html;
}

/* Suma del mes y datos rápidos, debajo del calendario */
function vfCalendarSummaryHTML(cal) {
  const past = cal.data.slice(1, cal.lastDay + 1);
  const total = past.reduce((s, d) => s + d.total, 0);
  const daysWith = past.filter(d => d.total > 0).length;
  const bestDay = past.reduce((best, d, i) => (d.total > (best ? best.total : 0) ? { day: i + 1, total: d.total } : best), null);
  const avg = cal.lastDay ? total / cal.lastDay : 0;
  const items = [
    `<div class="vf-cal-stat vf-cal-stat--main"><span>Total del mes${cal.offset === 0 ? ' (hasta hoy)' : ''}</span><strong>${total.toLocaleString('es-PE')}</strong></div>`,
    `<div class="vf-cal-stat"><span>Mejor día</span><strong>${bestDay ? `${bestDay.total.toLocaleString('es-PE')}` : '—'}</strong><small>${bestDay ? escapeHtml(vfDayLabel(cal.offset, bestDay.day)) : 'sin ventas'}</small></div>`,
    `<div class="vf-cal-stat"><span>Promedio por día</span><strong>${avg.toFixed(1)}</strong><small>${cal.lastDay} día${cal.lastDay === 1 ? '' : 's'} del mes${cal.offset === 0 ? ' hasta hoy' : ''}</small></div>`,
    `<div class="vf-cal-stat"><span>Días con ventas</span><strong>${daysWith}<em>/${cal.lastDay}</em></strong><small>${cal.lastDay - daysWith} sin ninguna</small></div>`,
  ];
  if (cal.offset === 0 && cal.lastDay < cal.days) {
    items.push(`<div class="vf-cal-stat vf-cal-stat--proj"><span>A este ritmo cierra en</span><strong>~${Math.round(avg * cal.days).toLocaleString('es-PE')}</strong><small>promedio × ${cal.days} días</small></div>`);
  }
  return items.join('');
}

function vfRenderCalendar() {
  const tl = vfSelectedTl();
  document.getElementById('vf-cal-scope').textContent = tl ? `· equipo de ${tl}` : '';
  document.getElementById('vf-cal-filter').innerHTML = [{ key: '', label: 'Todas' }, ...VF_SOURCES].map((s, i) => {
    const on = vfCalCampaign === s.key;
    const color = s.key ? vfColor(s, i - 1) : 'var(--nav-accent)';
    return `<button type="button" class="dash-tab ${on ? 'on' : ''}" role="tab" aria-selected="${on}" style="--c:${color}" onclick="vfSetCalCampaign('${s.key}')">${s.key ? countryFlag(s.country) : ''}${escapeHtml(s.label)}</button>`;
  }).join('');
  const cal = vfDailyData();
  if (vfCalDay && (vfCalDay > cal.lastDay)) vfCalDay = null;
  document.getElementById('vf-cal').innerHTML = vfCalendarHTML(cal, true);
  document.getElementById('vf-cal-summary').innerHTML = vfCalendarSummaryHTML(cal);
  vfRenderCalDetail(cal);
}

function vfSetCalCampaign(key) {
  vfCalCampaign = VF_SOURCES.some(s => s.key === key) ? key : '';
  vfRenderCalendar();
}

function vfPickDay(day) {
  vfCalDay = vfCalDay === day ? null : day;   // clic otra vez en el mismo día = cerrar el detalle
  vfRenderCalendar();
  if (vfCalDay) document.getElementById('vf-cal-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* Detalle del día elegido: total, por campaña y quién vendió */
function vfRenderCalDetail(cal) {
  const box = document.getElementById('vf-cal-detail');
  if (!vfCalDay) { box.hidden = true; box.innerHTML = ''; return; }
  const x = cal.data[vfCalDay];
  const ops = [...x.ops.values()].sort((a, b) => (b.total - a.total) || a.op.asesor.localeCompare(b.op.asesor));
  box.hidden = false;
  box.innerHTML = `
    <div class="vf-cal-detail-head">
      <div>
        <div class="vf-cal-detail-title">${escapeHtml(vfDayLabel(cal.offset, vfCalDay))}</div>
        <div class="vf-cal-detail-sub"><strong>${x.total}</strong> venta${x.total === 1 ? '' : 's'} de ${ops.length} OP${ops.length === 1 ? '' : 's'}
          ${VF_SOURCES.filter(s => x.counts[s.key]).map(s => `<span class="dash-chip">${countryFlag(s.country)}${escapeHtml(s.label)} <strong>${x.counts[s.key]}</strong></span>`).join('')}</div>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" onclick="vfPickDay(${vfCalDay})">✕ Cerrar</button>
    </div>
    ${ops.length ? `<div class="tbl-wrap"><table class="vf-table">
      <thead><tr><th>#</th><th>Operador</th><th>Team Leader</th>${VF_SOURCES.map(s => `<th class="num" title="${escapeHtml(s.label)}">${countryFlag(s.country)}${escapeHtml(s.code)}</th>`).join('')}<th class="num">Total</th></tr></thead>
      <tbody>${ops.map((o, i) => `<tr>
        <td class="dash-rank">${i < 3 ? TL_MEDALS[i] : i + 1}</td>
        <td class="nowrap"><div class="dash-op-name">${escapeHtml(o.op.asesor)}</div><div class="dash-op-code">${escapeHtml(o.op.perop)}</div></td>
        <td class="nowrap">${recTlBadge(o.op.tl)}</td>${vfCampaignCells(o.counts)}<td class="num vf-total">${o.total}</td></tr>`).join('')}</tbody>
    </table></div>` : '<div class="dash-empty">Nadie registró ventas por fuera este día.</div>'}`;
}

/* ══════════════════════════════
   EXPORTAR COMO IMAGEN — mismo sistema que Top TL y Leads (ancho fijo, nítida, igual para todos)
══════════════════════════════ */
function vfBuildExportCard() {
  const tl = vfSelectedTl();
  const all = vfBuildOps();
  const scope = tl ? all.filter(o => o.tl === tl) : all;
  const ops = vfFilteredOps({ includeZero: false });           // mismo orden que la tabla, solo con ventas
  const total = scope.reduce((s, o) => s + o.total, 0);
  const totals = vfEmptyCounts();
  scope.forEach(o => VF_SOURCES.forEach(s => { totals[s.key] += o.counts[s.key]; }));
  const tls = vfBuildTLs(all);
  const cal = vfDailyData();
  const now = new Date();
  const stamp = `${now.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;

  const card = document.createElement('div');
  card.className = 'vf-export';
  card.innerHTML = `
    <div class="tl-export-head">
      <div class="tl-export-title">🛒 Ventas por Fuera <span class="leads-export-mode">${escapeHtml(vfMonthLabel(vfSelectedOffset()))}${vfMonth === 'current' ? ' · en curso' : ''}</span></div>
      <div class="tl-export-stamp">${escapeHtml(stamp)}</div>
    </div>
    <div class="leads-export-sum">
      <span><strong>${total.toLocaleString('es-PE')}</strong> ventas${tl ? ` · equipo de <strong>${escapeHtml(tl)}</strong>` : ''}</span>
      ${VF_SOURCES.map(s => `<span>${countryFlag(s.country)}${escapeHtml(s.label)} <strong>${totals[s.key].toLocaleString('es-PE')}</strong></span>`).join('')}
    </div>
    <div class="vf-export-sub">Ventas por día ${vfCalCampaign ? `<span>(solo ${escapeHtml(VF_SOURCES.find(s => s.key === vfCalCampaign).label)})</span>` : ''}</div>
    <div class="vf-cal vf-cal--export">${vfCalendarHTML(cal, false)}</div>
    <div class="vf-cal-summary">${vfCalendarSummaryHTML(cal)}</div>
    ${tl ? '' : `<div class="vf-export-sub">Por Team Leader</div>
    <table class="tl-export-table vf-export-table">
      <thead><tr><th>#</th><th>Team Leader</th><th class="num">OPs con ventas</th>${vfCampaignHeads()}<th class="num">Total</th><th class="num">Prom. por OP</th></tr></thead>
      <tbody>${tls.map((t, i) => `<tr>
        <td class="dash-rank">${i < 3 && t.total ? TL_MEDALS[i] : i + 1}</td><td>${recTlBadge(t.tl)}</td>
        <td class="num">${t.withSales}/${t.ops}</td>${vfCampaignCells(t.counts)}
        <td class="num vf-total">${t.total}</td><td class="num">${t.ops ? (t.total / t.ops).toFixed(1) : '0'}</td></tr>`).join('')}</tbody>
    </table>`}
    <div class="vf-export-sub">Por Operador <span>(${ops.length} con ventas)</span></div>
    ${ops.length ? `<table class="tl-export-table vf-export-table">
      <thead><tr><th>#</th><th>Operador</th><th>Team Leader</th>${vfCampaignHeads()}<th class="num">Total</th></tr></thead>
      <tbody>${ops.map((o, i) => `<tr>
        <td class="dash-rank">${i + 1}</td>
        <td><div class="dash-op-name">${escapeHtml(o.asesor)}</div><div class="dash-op-code">${escapeHtml(o.perop)}</div></td>
        <td class="nowrap">${recTlBadge(o.tl)}</td>${vfCampaignCells(o.counts)}<td class="num vf-total">${o.total}</td></tr>`).join('')}</tbody>
    </table>` : '<div class="dash-empty">Todavía no hay ventas por fuera en este mes.</div>'}
    <div class="tl-export-foot">Solo ventas con ORDEN CREADA · cada orden cuenta una vez · solo OPs de la distribución actual</div>`;
  return card;
}

function vfExportImage(action) {
  if (!vfSales) return;
  const tl = vfSelectedTl();
  const d = vfMonthDate(vfSelectedOffset());
  return exportCardImage({
    action, build: vfBuildExportCard,
    filename: `ventas-por-fuera-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}${tl ? '-' + tl.toLowerCase().replace(/[^a-z0-9]+/gi, '-') : ''}.png`,
    statusId: 'vf-export-status', buttonIds: ['vf-copy-img-btn', 'vf-dl-img-btn'],
  });
}
