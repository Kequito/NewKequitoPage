/* Vista Ventas por Fuera — ventas registradas "por fuera" en 4 hojas de Google (una por campaña),
   leídas EN VIVO desde el navegador (core/sheets.js), cruzadas con la distribución actual (dt_dis).

   Reglas (acordadas con el equipo):
   · Venta = fila con "ORDEN CREADA" marcada (TRUE / VERDADERO).
   · Cada "ID ORDEN" cuenta UNA sola vez por hoja (a veces la misma orden se registra dos veces).
   · Solo cuentan los OPs que están HOY en la distribución; las ventas de otros no se muestran.
   · Solo el mes actual y el anterior, separados por la "Marca temporal" (d/m/aaaa).
   · Las hojas se emparejan con el OP por el NÚMERO del PEROP1AM (la hoja trae solo "41328").
   Los links se cambian en Actualización de Data (dt_data_links: vf_mexico, vf_peru, vf_paraguay, vf_uruguay);
   si no hay uno guardado se usa el de por defecto. Sirve el link "pubhtml" tal cual (errCsvUrl lo pasa a CSV).

   Pendientes (panel de arriba): TODO lo registrado en las hojas (de cualquier OP, esté o no en la distribución)
   en la jornada actual y las 3 anteriores, por turno según la HORA en que el OP lo subió (ver VF_SHIFTS).
   Cada orden tiene que terminar creada Y mandada a Trash, o revisada por un Team Leader:
   · Trash marcado sin crear = el OP la subió mal y un TL la marcó como error → resuelta.
   · Texto en "ID ORDEN CREADA" (ej. "APROBAR / SUSTAROX") = comentario de un TL → resuelta. */

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
let vfTasks = [];          // pendientes: [{ source, id, num, at, noTime, jornada, shift, needCreate, needTrash, state }] (ver vfParseTasks)
let vfTaskErr = {};        // source → texto si la hoja no permite revisar pendientes (falta una columna)
let vfTaskJornada = 0;     // jornada elegida: 0 = actual, 1 = anterior… o 'all' = las 4
let vfTaskShift = '';      // turno elegido: '' = todos, o la key de VF_SHIFTS
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

/* "4/10/2026 21:47:43" → Date (hora local). Sin hora → mediodía de ese día, con noTime (no se sabe el turno). */
function vfRowDateTime(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const day = Number(m[1]), month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const noTime = m[4] === undefined;
  const at = new Date(Number(m[3]), month - 1, day, noTime ? 12 : Number(m[4]), noTime ? 0 : Number(m[5]), noTime ? 0 : Number(m[6] || 0));
  return { at, noTime };
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
    trash: col(n => n === 'ORDEN TRASH'),
    newId: col(n => n === 'ID ORDEN CREADA'),
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
  const tasks = C.trash < 0 || C.newId < 0
    ? { error: `falta la columna ${C.trash < 0 ? '"ORDEN TRASH"' : '"ID ORDEN CREADA"'}` }
    : { list: vfParseTasks(src, table.slice(h + 1), C) };
  return { sales, dup, tasks };
}

async function vfInitView() {
  vfLoaded = true;
  vfSyncMonthButtons();
  await vfLoad();
}

/* silent = auto-refresh: sin "Cargando…", conserva filtros y mes */
/* Ventas válidas de las 4 hojas (sin dibujar nada) — para el Inicio. Si la sección ya las leyó hace
   menos de 5 min, usa esas; si alguna hoja falla, se usan las demás. */
let vfSharedCache = null;
async function vfFetchSalesShared() {
  if (vfSales && vfFetchedAt && Date.now() - new Date(vfFetchedAt).getTime() < 5 * 60 * 1000) return { sales: vfSales };
  if (vfSharedCache && Date.now() - vfSharedCache.at < 5 * 60 * 1000) return vfSharedCache;
  await vfFetchLinks();
  const results = await Promise.all(VF_SOURCES.map(src => sheetFetchCsv(errCsvUrl(vfSourceUrl(src)), `ventas por fuera de ${src.label}`)
    .then(table => vfParseTable(src, table).sales)
    .catch(err => { console.error(`Ventas por Fuera (Inicio): ${src.label}`, err); return null; })));
  if (results.every(r => r === null)) throw new Error('No se pudo leer ninguna hoja de Ventas por Fuera.');
  vfSharedCache = { sales: results.flatMap(r => r || []), at: Date.now() };
  return vfSharedCache;
}

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
      sbFetchAll('dt_dis', 'select=PEROP1AM,ASESORES,TEAMLEADER,PAIS&order=PEROP1AM.asc').catch(() => {
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
    vfTasks = [];
    vfTaskErr = {};
    results.forEach((r, i) => {
      const src = VF_SOURCES[i];
      vfStatus[src.key] = r.ok ? { ok: true, count: r.sales.length, dup: r.dup } : { ok: false, error: r.error };
      if (!r.ok) return;
      vfSales.push(...r.sales);
      if (r.tasks.error) vfTaskErr[src.key] = r.tasks.error;
      else vfTasks.push(...r.tasks.list);
    });
    vfFetchedAt = new Date().toISOString();
    errBox.hidden = true;
    document.getElementById('vf-loading').hidden = true;
    document.getElementById('vf-content').hidden = false;
    vfRenderStatus();
    vfPopulateTlFilter();
    vfRenderAll();
    vfRenderTasks();
  } catch (err) {
    console.error('Error cargando Ventas por Fuera:', err);
    errBox.innerHTML = `${escapeHtml((err && err.message) ? err.message : 'No se pudo cargar la información.')} ${uiRetryButton('vfLoad()')}`;
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
// El "hace X minutos" (y los turnos que van terminando) se mantienen al día solo mientras se mira la sección
let vfTick = 0;
setInterval(() => {
  if (typeof currentPage === 'undefined' || currentPage !== 'ventasfuera' || !vfFetchedAt) return;
  vfRenderUpdated();
  if (++vfTick % 2 === 0) vfRenderTasks();   // cada minuto: un turno puede haber cerrado (pendientes → vencidos)
}, 30 * 1000);

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
  document.getElementById('vf-tl-thead').innerHTML = `<tr><th>#</th><th>Team Leader</th><th class="num">OPs con ventas</th>${vfCampaignHeads(true)}<th class="num">Total</th><th class="num">Prom. por OP</th><th></th></tr>`;
  const max = Math.max(0, ...tls.map(t => t.total));
  document.getElementById('vf-tl-tbody').innerHTML = tls.map((t, i) => `
    <tr class="eq-row ${t.tl === selected ? 'vf-row-on' : ''}" onclick="vfPickTl(${jsArg(t.tl)})" title="Ver solo el equipo de ${escapeHtml(t.tl)}">
      <td class="dash-rank">${i < 3 && t.total ? TL_MEDALS[i] : i + 1}</td>
      <td>${recTlBadge(t.tl)}</td>
      <td class="num">${t.withSales}<span class="txt-light">/${t.ops}</span></td>
      ${vfCampaignCells(t.counts)}
      <td class="num vf-total"${vfHeat(t.total, max)}>${t.total}</td>
      <td class="num">${t.ops ? (t.total / t.ops).toFixed(1) : '0'}</td>
      <td class="vf-cal-btn-cell"><button type="button" class="btn btn-ghost btn-sm" onclick="event.stopPropagation();vfOpenCalendar('tl',${jsArg(t.tl)})" title="Ventas por día del equipo de ${escapeHtml(t.tl)}">📅 Calendario</button></td>
    </tr>`).join('') || '<tr><td colspan="10" class="td-empty">La distribución no tiene Team Leaders</td></tr>';
  const sumC = vfEmptyCounts();
  tls.forEach(t => VF_SOURCES.forEach(s => { sumC[s.key] += t.counts[s.key]; }));
  const ops = tls.reduce((s, t) => s + t.ops, 0), withS = tls.reduce((s, t) => s + t.withSales, 0), total = tls.reduce((s, t) => s + t.total, 0);
  document.getElementById('vf-tl-tfoot').innerHTML = tls.length
    ? `<tr><td></td><td>Total</td><td class="num">${withS}<span class="txt-light">/${ops}</span></td>${VF_SOURCES.map(s => `<td class="num">${sumC[s.key]}</td>`).join('')}<td class="num">${total}</td><td class="num">${ops ? (total / ops).toFixed(1) : '0'}</td><td></td></tr>`
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
  return rows.map((o, i) => `<tr class="eq-row ${o.total ? '' : 'ol-inactive'}" onclick="vfOpenCalendar('op',${jsArg(o.num)})" title="Ver ventas por día de ${escapeHtml(o.asesor)}">
    <td class="dash-rank">${i + 1}</td>
    <td><div class="dash-op-name">${escapeHtml(o.asesor)}</div><div class="dash-op-code">${escapeHtml(o.perop)}</div></td>
    <td class="nowrap">${recTlBadge(o.tl)}</td>
    <td class="nowrap">${o.pais ? `${countryFlag(o.pais)}${escapeHtml(o.pais)}` : '<span class="txt-light">—</span>'}</td>
    ${vfCampaignCells(o.counts)}
    <td class="num vf-total"${vfHeat(o.total, max)}>${o.total}</td>
  </tr>`).join('');
}

/* ══════════════════════════════
   PENDIENTES — órdenes por crear / por mandar a Trash, por jornada y turno
   El turno responsable sale de la HORA en que el OP subió la orden a la hoja (desde "from", en minutos
   desde las 0:00). Cada turno tiene hasta el final de su horario de trabajo ("end") para dejarlas listas:
   después, lo que falte queda "vencido". La jornada empieza con el AM (6:30 a.m.) y termina con la
   Madrugada (6:30 a.m. del día siguiente): una orden subida a las 2 a.m. es de la Madrugada de la jornada anterior.
══════════════════════════════ */
const VF_SHIFTS = [
  { key: 'AM',  label: 'Turno AM',  icon: '🌅', from: 390,  end: 16 * 60,          hours: '6:30 a.m. y 2:30 p.m.', close: '4:00 p.m.' },
  { key: 'PM',  label: 'Turno PM',  icon: '🌇', from: 870,  end: 22 * 60,          hours: '2:30 p.m. y 9:30 p.m.', close: '10:00 p.m.' },
  { key: 'MAD', label: 'Madrugada', icon: '🌙', from: 1290, end: 24 * 60 + 7 * 60, hours: '9:30 p.m. y 6:30 a.m.', close: '7:00 a.m.' },
];
const VF_TASK_DAYS = 4;   // jornada actual + las 3 anteriores

function vfDateKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function vfKeyDate(key, minutes = 0) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d, 0, minutes); }
function vfShiftInfo(key) { return VF_SHIFTS.find(s => s.key === key); }

/* Fecha y hora → { jornada: 'aaaa-mm-dd', shift } */
function vfShiftOf(at) {
  const m = at.getHours() * 60 + at.getMinutes();
  const shift = m >= 390 && m < 870 ? 'AM' : (m >= 870 && m < 1290 ? 'PM' : 'MAD');
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() - (m < 390 ? 1 : 0));
  return { jornada: vfDateKey(day), shift };
}
function vfShiftStart(jornada, key) { return vfKeyDate(jornada, vfShiftInfo(key).from); }
function vfShiftDeadline(jornada, key) { return vfKeyDate(jornada, vfShiftInfo(key).end); }

/* Las jornadas que se revisan, de la actual hacia atrás */
function vfTaskJornadas(now = new Date()) {
  const cur = vfKeyDate(vfShiftOf(now).jornada);
  return Array.from({ length: VF_TASK_DAYS }, (_, i) => vfDateKey(new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() - i)));
}
function vfJornadaLabel(key, i) {
  if (i === 0) return 'Hoy';
  if (i === 1) return 'Ayer';
  const d = vfKeyDate(key);
  return `${VF_WEEKDAYS[(d.getDay() + 6) % 7]} ${d.getDate()}`;
}
function vfJornadaLong(key) {
  const s = vfKeyDate(key).toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* Filas de una hoja → una entrada por ID ORDEN subido en las jornadas que se revisan.
   Si el mismo ID se subió más de una vez: cuenta como creada / en Trash si CUALQUIERA de sus filas lo está;
   si no se creó, manda la ÚLTIMA fila (Trash sin crear o comentario de un TL = revisada). */
function vfParseTasks(src, rows, C) {
  const keep = new Set(vfTaskJornadas());
  const byId = new Map();
  rows.forEach(r => {
    const id = String(r[C.id] ?? '').trim();
    if (!id) return;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(r);
  });
  const yes = v => VF_CREATED_VALUES.includes(errNorm(v));
  const out = [];
  byId.forEach((list, id) => {
    const firstRow = list.find(r => vfRowDateTime(r[C.date]));
    if (!firstRow) return;
    const { at, noTime } = vfRowDateTime(firstRow[C.date]);
    const { jornada, shift } = vfShiftOf(at);
    if (!keep.has(jornada)) return;
    const created = list.some(r => yes(r[C.created]));
    const trash = list.some(r => yes(r[C.trash]));
    const last = list[list.length - 1];
    const note = String(last[C.newId] ?? '').trim();
    const reviewed = !created && (yes(last[C.trash]) || /[a-z]/i.test(note));
    // ok = creada y en Trash · tl = revisada por un TL (error / comentario) · trash = falta Trash · create = falta crear
    const state = created ? (trash ? 'ok' : 'trash') : (reviewed ? 'tl' : 'create');
    out.push({
      source: src.key, id, num: sheetOperatorNumber(firstRow[C.user]), at, noTime, jornada, shift, state,
      needCreate: state === 'create',
      needTrash: state === 'trash' || (state === 'create' && !trash),
    });
  });
  return out;
}

function vfTaskPending(t) { return t.needCreate || t.needTrash; }
function vfTaskOverdue(t, now = new Date()) { return vfTaskPending(t) && now >= vfShiftDeadline(t.jornada, t.shift); }

/* "faltan crear 3 órdenes y mandar 4 a Trash" */
function vfTaskPhrase(create, trash) {
  const parts = [];
  if (create) parts.push(`crear <strong>${create}</strong> orden${create === 1 ? '' : 'es'}`);
  if (trash) parts.push(`mandar <strong>${trash}</strong> a Trash`);
  const one = (create || trash) === 1 && (!create || !trash);
  return `${one ? 'falta' : 'faltan'} ${parts.join(' y ')}`;
}

function vfTaskCount(list) {
  const c = { total: list.length, created: 0, trash: 0, tl: 0, needCreate: 0, needTrash: 0, pending: 0 };
  list.forEach(t => {
    if (t.state === 'ok' || t.state === 'trash') c.created++;
    if (t.state === 'ok') c.trash++;
    if (t.state === 'tl') c.tl++;
    if (t.needCreate) c.needCreate++;
    if (t.needTrash) c.needTrash++;
    if (vfTaskPending(t)) c.pending++;
  });
  return c;
}

function vfTaskInJornada(t) { return vfTaskJornada === 'all' || t.jornada === vfTaskJornadas()[vfTaskJornada]; }
function vfTaskSelected() { return vfTasks.filter(t => vfTaskInJornada(t) && (!vfTaskShift || t.shift === vfTaskShift)); }

function vfSetTaskJornada(j) { vfTaskJornada = j === 'all' ? 'all' : (Number(j) || 0); vfRenderTasks(); }
function vfSetTaskShift(key) { vfTaskShift = vfTaskShift === key ? '' : key; vfRenderTasks(); }
/* Desde los avisos: una jornada y (opcional) un turno, de una vez */
function vfShowTasks(j, shift = '') { vfTaskJornada = j; vfTaskShift = shift; vfRenderTasks(); }

function vfTaskScopeLabel() {
  const js = vfTaskJornadas();
  const j = vfTaskJornada === 'all' ? `últimas ${VF_TASK_DAYS} jornadas`
    : vfTaskJornada === 0 ? 'jornada de hoy'
    : vfTaskJornada === 1 ? 'jornada de ayer'
    : `jornada del ${vfJornadaLong(js[vfTaskJornada]).toLowerCase()}`;
  return `${j} · ${vfTaskShift ? vfShiftInfo(vfTaskShift).label : 'todos los turnos'}`;
}

function vfRenderTasks() {
  if (!vfSales) return;
  const now = new Date();
  vfRenderTaskAlerts(now);
  vfRenderTaskJornadas(now);
  vfRenderTaskShifts(now);
  vfRenderTaskTable();
  vfRenderTaskList(now);
}

/* Avisos de arriba: la jornada de hoy y lo que quedó de días anteriores */
function vfRenderTaskAlerts(now) {
  const js = vfTaskJornadas(now);
  const pend = vfTasks.filter(vfTaskPending);
  const today = pend.filter(t => t.jornada === js[0]);
  const before = pend.filter(t => t.jornada !== js[0]);
  const html = [];

  if (today.length) {
    const c = vfTaskCount(today);
    const late = today.filter(t => vfTaskOverdue(t, now)).length;
    const byShift = VF_SHIFTS.map(sh => [sh, vfTaskCount(today.filter(t => t.shift === sh.key))]).filter(([, x]) => x.pending);
    html.push(`<div class="vfp-alert ${late ? 'is-bad' : 'is-warn'}">
      <span class="vfp-alert-ico">${late ? '⛔' : '⏳'}</span>
      <div class="vfp-alert-txt">
        <div><strong>Jornada de hoy:</strong> ${vfTaskPhrase(c.needCreate, c.needTrash)}.${late ? ` <strong>${late}</strong> ${late === 1 ? 'es' : 'son'} de un turno que ya terminó.` : ''}</div>
        <div class="vfp-alert-chips">${byShift.map(([sh, x]) => `<button type="button" class="vfp-mini" onclick="vfShowTasks(0,'${sh.key}')">${sh.icon} ${escapeHtml(sh.label)}: ${[x.needCreate ? `${x.needCreate} por crear` : '', x.needTrash ? `${x.needTrash} a Trash` : ''].filter(Boolean).join(' · ')}</button>`).join('')}</div>
      </div>
    </div>`);
  } else {
    html.push(`<div class="vfp-alert is-ok"><span class="vfp-alert-ico">✓</span><div class="vfp-alert-txt"><strong>Jornada de hoy al día:</strong> no falta crear ninguna orden ni mandar ninguna a Trash.</div></div>`);
  }

  if (before.length) {
    const c = vfTaskCount(before);
    const days = js.map((j, i) => [j, i, before.filter(t => t.jornada === j).length]).filter(([, i, n]) => i > 0 && n);
    html.push(`<div class="vfp-alert is-bad">
      <span class="vfp-alert-ico">⚠</span>
      <div class="vfp-alert-txt">
        <div><strong>Quedaron órdenes pendientes de días anteriores:</strong> ${vfTaskPhrase(c.needCreate, c.needTrash)}.</div>
        <div class="vfp-alert-chips">${days.map(([j, i, n]) => `<button type="button" class="vfp-mini" onclick="vfShowTasks(${i})" title="${escapeHtml(vfJornadaLong(j))}">${vfJornadaLabel(j, i)}: ${n} orden${n === 1 ? '' : 'es'}</button>`).join('')}</div>
      </div>
    </div>`);
  }

  // Hojas que no se pudieron revisar (los números de arriba no las incluyen)
  const off = VF_SOURCES.filter(s => (vfStatus[s.key] && !vfStatus[s.key].ok) || vfTaskErr[s.key]);
  if (off.length) {
    html.push(`<div class="vfp-alert is-muted"><span class="vfp-alert-ico">ⓘ</span><div class="vfp-alert-txt">No se pudo revisar: ${off.map(s => `${escapeHtml(s.label)} (${escapeHtml(vfTaskErr[s.key] || 'hoja no disponible')})`).join(' · ')}. Los números no la incluyen.</div></div>`);
  }
  document.getElementById('vfp-alerts').innerHTML = html.join('');
}

function vfRenderTaskJornadas(now) {
  const js = vfTaskJornadas(now);
  const pend = vfTasks.filter(vfTaskPending);
  const chip = (key, label, n, title, isPrev) => {
    const on = String(vfTaskJornada) === String(key);
    const tone = n ? (isPrev ? 'var(--red)' : 'var(--amber)') : 'var(--green)';
    return `<button type="button" class="dash-tab ${on ? 'on' : ''}" role="tab" aria-selected="${on}" style="--c:${on ? 'var(--nav-accent)' : tone}" onclick="vfSetTaskJornada('${key}')" title="${escapeHtml(title)}">${label}<span class="vfp-badge" style="--c:${tone}">${n || '✓'}</span></button>`;
  };
  document.getElementById('vfp-jornadas').innerHTML = js.map((j, i) => chip(i, vfJornadaLabel(j, i), pend.filter(t => t.jornada === j).length,
    `${vfJornadaLong(j)} — de 6:30 a.m. a 6:30 a.m. del día siguiente`, i > 0)).join('')
    + chip('all', `Últimos ${VF_TASK_DAYS} días`, pend.length, `Las ${VF_TASK_DAYS} jornadas juntas`, pend.some(t => t.jornada !== js[0]));
}

/* Una tarjeta por turno (clic = ver solo ese turno; otra vez = todos) */
function vfRenderTaskShifts(now) {
  const js = vfTaskJornadas(now);
  const inJ = vfTasks.filter(vfTaskInJornada);
  document.getElementById('vfp-shifts').innerHTML = VF_SHIFTS.map(sh => {
    const list = inJ.filter(t => t.shift === sh.key);
    const c = vfTaskCount(list);
    let status = '';
    let tone = c.pending ? 'warn' : 'ok';
    if (vfTaskJornada !== 'all') {
      const j = js[vfTaskJornada];
      if (now < vfShiftStart(j, sh.key)) { status = '<span class="vfp-st">Todavía no empieza</span>'; tone = 'idle'; }
      else if (now < vfShiftDeadline(j, sh.key)) status = `<span class="vfp-st is-live">● En curso · cierra ${sh.close}</span>`;
      else {
        status = `<span class="vfp-st ${c.pending ? 'is-bad' : ''}">Terminó${c.pending ? ' con pendientes' : ''}</span>`;
        if (c.pending) tone = 'bad';
      }
    } else if (list.some(t => vfTaskOverdue(t, now))) tone = 'bad';
    const body = c.pending
      ? `<div class="vfp-shift-nums">
          <span class="${c.needCreate ? 'is-on' : ''}"><strong>${c.needCreate}</strong>por crear</span>
          <span class="${c.needTrash ? 'is-on' : ''}"><strong>${c.needTrash}</strong>a Trash</span>
        </div>`
      : `<div class="vfp-shift-done">${c.total ? '✓ Todo listo' : (tone === 'idle' ? '—' : 'Sin órdenes')}</div>`;
    const on = vfTaskShift === sh.key;
    return `<button type="button" class="vfp-shift is-${tone} ${on ? 'is-on' : ''}" onclick="vfSetTaskShift('${sh.key}')" aria-pressed="${on}" title="${on ? 'Ver todos los turnos' : `Ver solo el ${escapeHtml(sh.label)}`}">
      <div class="vfp-shift-head"><span class="vfp-shift-name">${sh.icon} ${escapeHtml(sh.label)}</span>${status}</div>
      <div class="vfp-shift-hours">Órdenes subidas entre ${sh.hours} · listas hasta las ${sh.close}</div>
      ${body}
      <div class="vfp-shift-sub">${c.total} subida${c.total === 1 ? '' : 's'} · ${c.created} creada${c.created === 1 ? '' : 's'}${c.tl ? ` · ${c.tl} revisada${c.tl === 1 ? '' : 's'} por TL` : ''}</div>
    </button>`;
  }).join('');
}

/* Tabla por campaña del filtro elegido */
function vfRenderTaskTable() {
  const sel = vfTaskSelected();
  const cell = (n, cls = '') => `<td class="num ${n ? cls : 'vf-zero'}">${n || '·'}</td>`;
  const row = c => `${cell(c.total)}${cell(c.created)}${cell(c.trash)}${cell(c.tl)}${cell(c.needCreate, 'vfp-need')}${cell(c.needTrash, 'vfp-need')}`;
  document.getElementById('vfp-thead').innerHTML = `<tr><th>Campaña <span class="muted-normal">· ${escapeHtml(vfTaskScopeLabel())}</span></th><th class="num">Subidas</th><th class="num" title="Ya tienen la orden nueva creada">Creadas</th><th class="num" title="Creadas y con la original ya en Trash">Listas</th><th class="num" title="Marcadas como error o con comentario de un Team Leader">Revisadas TL</th><th class="num">Falta crear</th><th class="num">Falta Trash</th></tr>`;
  document.getElementById('vfp-tbody').innerHTML = VF_SOURCES.map(s => {
    const name = `<td class="nowrap">${countryFlag(s.country)}${escapeHtml(s.label)}</td>`;
    if ((vfStatus[s.key] && !vfStatus[s.key].ok) || vfTaskErr[s.key]) {
      return `<tr class="ol-inactive">${name}<td colspan="6" class="txt-light">No se pudo revisar (${escapeHtml(vfTaskErr[s.key] || 'hoja no disponible')})</td></tr>`;
    }
    return `<tr>${name}${row(vfTaskCount(sel.filter(t => t.source === s.key)))}</tr>`;
  }).join('');
  document.getElementById('vfp-tfoot').innerHTML = `<tr><td>Total</td>${row(vfTaskCount(sel))}</tr>`;
}

/* Quién subió la orden: nombre si está en la distribución, si no solo su número */
function vfTaskOpHTML(num) {
  const o = num && vfOps.find(x => x.num === num);
  return o
    ? `<div class="dash-op-name">${escapeHtml(o.asesor)}</div><div class="dash-op-code">${escapeHtml(o.perop)} · ${escapeHtml(o.tl)}</div>`
    : `<div class="dash-op-name">${num ? `OP ${escapeHtml(num)}` : '—'}</div><div class="dash-op-code">fuera de la distribución</div>`;
}
function vfTaskTime(t) {
  const d = t.at;
  return `${d.getDate()}/${d.getMonth() + 1} ${t.noTime ? '(sin hora)' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`}`;
}

/* Lista de órdenes pendientes del filtro elegido, la más antigua primero */
function vfRenderTaskList(now) {
  const list = vfTaskSelected().filter(vfTaskPending).sort((a, b) => a.at - b.at);
  const box = document.getElementById('vfp-list');
  if (!list.length) {
    box.innerHTML = `<div class="vfp-list-empty">✓ No hay órdenes pendientes en la ${escapeHtml(vfTaskScopeLabel())}.</div>`;
    return;
  }
  const js = vfTaskJornadas(now);
  box.innerHTML = `<div class="vfp-list-head">Órdenes pendientes <span class="muted-normal">(${list.length}) · la más antigua primero</span></div>
    <div class="tbl-wrap"><table class="vf-table vfp-list-table">
      <thead><tr><th>Campaña</th><th>ID orden</th><th>Subida</th><th>Turno</th><th>Operador</th><th>Falta</th><th>Estado</th></tr></thead>
      <tbody>${list.map(t => {
        const src = VF_SOURCES.find(s => s.key === t.source);
        const sh = vfShiftInfo(t.shift);
        const late = vfTaskOverdue(t, now);
        return `<tr class="${late ? 'vfp-late' : ''}">
          <td class="nowrap">${countryFlag(src.country)}${escapeHtml(src.code)}</td>
          <td><button type="button" class="btn btn-ghost btn-sm rec-link-trigger" onclick="recOpenLinkMenu(event,${jsArg(t.id)})" title="Abrir la orden (Change / View)">#${escapeHtml(t.id)} ▾</button></td>
          <td class="nowrap">${vfTaskTime(t)}<div class="dash-op-code">${repTimeAgo(t.at.toISOString())}</div></td>
          <td class="nowrap">${sh.icon} ${escapeHtml(sh.label)}${vfTaskJornada === 'all' ? `<div class="dash-op-code">jornada: ${vfJornadaLabel(t.jornada, js.indexOf(t.jornada))}</div>` : ''}</td>
          <td class="nowrap">${vfTaskOpHTML(t.num)}</td>
          <td class="nowrap">${t.needCreate ? '<span class="vfp-tag is-create">Crear</span>' : ''}${t.needTrash ? '<span class="vfp-tag is-trash">Trash</span>' : ''}</td>
          <td class="nowrap">${late ? '<span class="vfp-tag is-late">Vencida</span>' : `<span class="txt-light">hasta las ${sh.close}</span>`}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

/* Resumen en texto de lo que falta (filtro elegido), con los IDs por campaña */
async function vfTaskCopy() {
  if (!vfSales) return;
  const list = vfTaskSelected().filter(vfTaskPending).sort((a, b) => a.at - b.at);
  const c = vfTaskCount(list);
  const scope = vfTaskScopeLabel();
  const lines = [`⏰ Pendientes de Ventas por Fuera — ${scope.charAt(0).toUpperCase()}${scope.slice(1)}`];
  if (!list.length) lines.push('✓ Todo al día: no falta crear ni mandar a Trash ninguna orden.');
  else {
    lines.push(`Falta crear: ${c.needCreate} · Falta mandar a Trash: ${c.needTrash}`);
    VF_SOURCES.forEach(s => {
      const mine = list.filter(t => t.source === s.key);
      if (!mine.length) return;
      lines.push('', `${s.label} (${mine.length}):`);
      mine.forEach(t => lines.push(`• ${t.id} — ${[t.needCreate ? 'crear' : '', t.needTrash ? 'Trash' : ''].filter(Boolean).join(' + ')} · ${vfShiftInfo(t.shift).label} · ${vfTaskTime(t)}${vfTaskOverdue(t) ? ' · VENCIDA' : ''}`));
    });
  }
  const ok = await gcCopyText(lines.join('\n'));
  gcSetStatus('vfp-copy-status', ok ? GC_MSG.textCopied : 'No se pudo copiar, intenta de nuevo.', ok ? 'ok' : 'error');
}

/* ══════════════════════════════
   CALENDARIO — ventas de cada día del mes elegido (lo usan los diálogos de un OP y de un equipo)
══════════════════════════════ */
const VF_WEEKDAYS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

function vfColor(src, i = 0) { return REP_COUNTRY_COLORS[src.country] || REP_FALLBACK_COLORS[i % REP_FALLBACK_COLORS.length]; }

function vfDaysInMonth(offset) {
  const d = vfMonthDate(offset);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/* Ventas de cada día (1..fin de mes) con su detalle por campaña y por OP, del OP (num) o del equipo (tl) pedido */
function vfDailyData({ tl = '', num = null, campaign = '' } = {}) {
  const offset = vfSelectedOffset();
  const month = vfMonthKey(offset);
  const opsByNum = new Map(vfOps.filter(o => (!tl || o.tl === tl) && (!num || o.num === num)).map(o => [o.num, o]));
  const days = vfDaysInMonth(offset);
  const data = Array.from({ length: days + 1 }, () => ({ total: 0, counts: vfEmptyCounts(), ops: new Map(), sales: [] }));
  (vfSales || []).forEach(s => {
    if (s.month !== month || !opsByNum.has(s.num)) return;
    if (campaign && s.source !== campaign) return;
    const d = data[s.day];
    if (!d || s.day < 1) return;             // fecha imposible en la hoja (ej. 31/9): se ignora
    d.total++;
    d.counts[s.source]++;
    d.sales.push(s);
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

/* La cuadrícula. interactive = días clicables (onPick recibe el día; selected = día marcado) */
function vfCalendarHTML(cal, interactive, { onPick = 'vfDlgPickDay', selected = null } = {}) {
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
      !future && !x.total ? 'is-zero' : '', interactive && selected === d ? 'is-on' : ''].join(' ');
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
      ? `<button type="button" class="${cls}" style="--a:${alpha}" onclick="${onPick}(${d})" title="${escapeHtml(tip)}">${inner}</button>`
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

/* ══════════════════════════════
   CALENDARIO DE UN OP O DE UN EQUIPO (diálogo)
   Mismo calendario del mes elegido, pero solo con las ventas de ese OP o de los OPs de ese Team Leader.
   Tiene su propio filtro de campaña y su propio día elegido (no tocan los de la sección).
   Clic en un día: OP → las órdenes de ese día (con Change / View) · equipo → quién vendió ese día.
══════════════════════════════ */
let vfDlg = null;        // { type: 'op' | 'tl', key, campaign, day, box }
let vfDlgClose = null;   // cierra el diálogo abierto
let vfDlgNext = null;    // calendario a abrir apenas se cierre el actual (clic en un OP dentro del de su equipo)

async function vfOpenCalendar(type, key) {
  if (!vfSales) return;
  if (type === 'op' && !vfOps.some(o => o.num === key)) return;
  if (vfDlg) { vfDlgNext = { type, key }; if (vfDlgClose) vfDlgClose(true); return; }
  vfDlg = { type, key, campaign: '', day: null, box: uiEl('div', 'vf-dlg') };
  vfDlgRender();
  await uiDialog({
    title: type === 'op' ? 'Ventas por día del OP' : 'Ventas por día del equipo',
    body: vfDlg.box, wide: true, confirmText: 'Cerrar', cancelText: null,
    bindClose: c => { vfDlgClose = c; },
  });
  vfDlg = null;
  vfDlgClose = null;
  if (vfDlgNext) { const n = vfDlgNext; vfDlgNext = null; vfOpenCalendar(n.type, n.key); }
}

function vfDlgSetCampaign(key) { if (!vfDlg) return; vfDlg.campaign = VF_SOURCES.some(s => s.key === key) ? key : ''; vfDlgRender(); }
function vfDlgPickDay(day) { if (!vfDlg) return; vfDlg.day = vfDlg.day === day ? null : day; vfDlgRender(); }

function vfDlgRender() {
  if (!vfDlg) return;
  const { type, key, campaign } = vfDlg;
  const cal = vfDailyData(type === 'op' ? { tl: '', num: key, campaign } : { tl: key, num: null, campaign });
  if (vfDlg.day && vfDlg.day > cal.lastDay) vfDlg.day = null;
  const day = vfDlg.day;
  const monthTotal = cal.data.slice(1).reduce((s, d) => s + d.total, 0);
  const totals = vfEmptyCounts();
  cal.data.slice(1).forEach(d => VF_SOURCES.forEach(s => { totals[s.key] += d.counts[s.key]; }));

  // Encabezado: quién es
  let head;
  if (type === 'op') {
    const o = vfOps.find(x => x.num === key);
    head = `<div class="vf-dlg-who">
      <div class="vf-dlg-name">${escapeHtml(o.asesor)}</div>
      <div class="vf-dlg-sub">${escapeHtml(o.perop)} · ${recTlBadge(o.tl)} ${o.pais ? `· ${countryFlag(o.pais)}${escapeHtml(o.pais)}` : ''}</div>
    </div>`;
  } else {
    const team = vfOps.filter(x => x.tl === key);
    head = `<div class="vf-dlg-who">
      <div class="vf-dlg-name">${recTlBadge(key)}</div>
      <div class="vf-dlg-sub">Equipo de ${team.length} OP${team.length === 1 ? '' : 's'} en la distribución actual</div>
    </div>`;
  }
  const chips = [{ key: '', label: 'Todas' }, ...VF_SOURCES].map((s, i) => {
    const on = campaign === s.key;
    const color = s.key ? vfColor(s, i - 1) : 'var(--nav-accent)';
    return `<button type="button" class="dash-tab ${on ? 'on' : ''}" style="--c:${color}" onclick="vfDlgSetCampaign('${s.key}')">${s.key ? countryFlag(s.country) : ''}${escapeHtml(s.label)}</button>`;
  }).join('');

  // Debajo del calendario: el día elegido, o (en un equipo) el ranking del mes
  let below = '';
  if (day) {
    const x = cal.data[day];
    if (type === 'op') {
      below = `<div class="vf-dlg-sec">${escapeHtml(vfDayLabel(cal.offset, day))} · <strong>${x.total}</strong> venta${x.total === 1 ? '' : 's'}</div>
        ${x.sales.length ? `<div class="vf-dlg-orders">${x.sales.map(s => {
          const src = VF_SOURCES.find(v => v.key === s.source);
          return `<div class="vf-dlg-order">${countryFlag(src.country)}<span>${escapeHtml(src.label)}</span>
            <button type="button" class="btn btn-ghost btn-sm rec-link-trigger" onclick="recOpenLinkMenu(event,${jsArg(s.id)})" title="Abrir la orden (Change / View)">#${escapeHtml(s.id)} ▾</button></div>`;
        }).join('')}</div>` : '<div class="dash-empty">Sin ventas por fuera este día.</div>'}`;
    } else {
      const ops = [...x.ops.values()].sort((a, b) => (b.total - a.total) || a.op.asesor.localeCompare(b.op.asesor));
      below = `<div class="vf-dlg-sec">${escapeHtml(vfDayLabel(cal.offset, day))} · <strong>${x.total}</strong> venta${x.total === 1 ? '' : 's'} de ${ops.length} OP${ops.length === 1 ? '' : 's'}</div>
        ${ops.length ? vfDlgOpsTable(ops.map(o => ({ op: o.op, counts: o.counts, total: o.total }))) : '<div class="dash-empty">Nadie del equipo registró ventas por fuera este día.</div>'}`;
    }
  } else if (type === 'tl') {
    const month = vfMonthKey(cal.offset);
    const byNum = new Map(vfOps.filter(o => o.tl === key).map(o => [o.num, { op: o, counts: vfEmptyCounts(), total: 0 }]));
    (vfSales || []).forEach(s => {
      const r = byNum.get(s.num);
      if (!r || s.month !== month || (campaign && s.source !== campaign)) return;
      r.counts[s.source]++;
      r.total++;
    });
    const ranking = [...byNum.values()].sort((a, b) => (b.total - a.total) || a.op.asesor.localeCompare(b.op.asesor));
    below = `<div class="vf-dlg-sec">Su equipo en ${escapeHtml(vfMonthLabel(cal.offset))} <small>· clic en un día del calendario para ver quién vendió ese día</small></div>
      ${vfDlgOpsTable(ranking)}`;
  } else {
    below = '<div class="vf-dlg-hint">Clic en un día para ver sus órdenes (con Change / View).</div>';
  }

  vfDlg.box.innerHTML = `
    <div class="vf-dlg-head">
      ${head}
      <div class="vf-dlg-total"><span>${escapeHtml(vfMonthLabel(cal.offset))}${cal.offset === 0 ? ' (en curso)' : ''}</span><strong>${monthTotal.toLocaleString('es-PE')}</strong><small>venta${monthTotal === 1 ? '' : 's'} por fuera</small></div>
    </div>
    <div class="vf-dlg-camps">${VF_SOURCES.map(s => `<span class="dash-chip">${countryFlag(s.country)}${escapeHtml(s.label)} <strong>${totals[s.key]}</strong></span>`).join('')}</div>
    <div class="vf-cal-filter vf-dlg-filter" role="tablist" aria-label="Campaña">${chips}</div>
    <div class="vf-cal">${vfCalendarHTML(cal, true, { onPick: 'vfDlgPickDay', selected: day })}</div>
    <div class="vf-cal-summary">${vfCalendarSummaryHTML(cal)}</div>
    <div class="vf-dlg-below">${below}</div>`;
}

/* Tabla de OPs con sus ventas por campaña (ranking del equipo / quién vendió un día). Clic = calendario de ese OP */
function vfDlgOpsTable(rows) {
  return `<div class="tbl-wrap"><table class="vf-table">
    <thead><tr><th>#</th><th>Operador</th>${VF_SOURCES.map(s => `<th class="num" title="${escapeHtml(s.label)}">${countryFlag(s.country)}${escapeHtml(s.code)}</th>`).join('')}<th class="num">Total</th></tr></thead>
    <tbody>${rows.map((r, i) => `<tr class="eq-row ${r.total ? '' : 'ol-inactive'}" onclick="vfOpenCalendar('op',${jsArg(r.op.num)})" title="Ver el calendario de ${escapeHtml(r.op.asesor)}">
      <td class="dash-rank">${i < 3 && r.total ? TL_MEDALS[i] : i + 1}</td>
      <td class="nowrap"><div class="dash-op-name">${escapeHtml(r.op.asesor)}</div><div class="dash-op-code">${escapeHtml(r.op.perop)}</div></td>
      ${vfCampaignCells(r.counts)}<td class="num vf-total">${r.total}</td></tr>`).join('')}</tbody>
  </table></div>`;
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
  const now = new Date();
  const stamp = `${now.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${now.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;

  const card = document.createElement('div');
  card.className = 'vf-export';
  card.innerHTML = `
    ${gcExportHead('🛒 Ventas por Fuera', { sub: `${escapeHtml(vfMonthLabel(vfSelectedOffset()))}${vfMonth === 'current' ? ' · en curso' : ''}`, stamp: now })}
    <div class="leads-export-sum">
      <span><strong>${total.toLocaleString('es-PE')}</strong> ventas${tl ? ` · equipo de <strong>${escapeHtml(tl)}</strong>` : ''}</span>
      ${VF_SOURCES.map(s => `<span>${countryFlag(s.country)}${escapeHtml(s.label)} <strong>${totals[s.key].toLocaleString('es-PE')}</strong></span>`).join('')}
    </div>
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
    ${gcExportFoot('Solo ventas con ORDEN CREADA · cada orden cuenta una vez · solo OPs de la distribución actual')}`;
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
