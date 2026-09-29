/* Vista Stats OPs Live (NUEVA — en prueba) — mismas métricas que Stats OPs Today (ventas, approve,
   reject, trash…), pero leídas DIRECTO de una hoja de Google publicada (sin subir Excel) y cruzadas
   con la distribución actual (GoodDay / dt_dis). Si queda bien, reemplaza a Stats OPs Today.

   · Emparejamiento por el NÚMERO del operador: la hoja usa prefijos distintos (PEROP1AM-, COLOP1AM-,
     CO-OPERATOR-…) y la distribución usa PEROP1AM-…, así que se compara solo el número final.
   · Duplicados: un mismo número puede aparecer varias veces en la hoja (varios bloques). Se toma la
     FILA COMPLETA con más Órdenes Únicas — no se suman.
   · Filas con datos pero sin operador no se pueden asignar a nadie: se ignoran (y se informan).
   · Solo se listan los OPs que ASISTIERON: "A" en la hoja de asistencia (core/attendance.js).
   · No depende de opstoday.js, así se puede borrar la sección vieja sin romper esta.
     Lectura de hojas compartida en core/sheets.js. */

const OL_SHEET_CSV_URL  = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTaY3-7JndelqNcM4ZB_HMJoDld6N9TGs2ajOhsF6s0atBTxH-U3HYBewObJo20s3hx2jt2SwZxw6sL/pub?gid=1047799153&single=true&output=csv';
const OL_SHEET_VIEW_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTaY3-7JndelqNcM4ZB_HMJoDld6N9TGs2ajOhsF6s0atBTxH-U3HYBewObJo20s3hx2jt2SwZxw6sL/pubhtml?gid=1047799153&single=true';
const OL_TOP_N = 7;

let olLoaded = false;
let olBusy = false;
let olRows = [];              // un registro por OP de la distribución CON ASISTENCIA "A", con su fila de ventas (o sin datos)
let olMeta = null;            // { fetchedAt, sheetOps, dupResolved, unnamedRows, distTotal, present }
let olCampaignMode = 'normal';
let olSort = { key: 'approve', dir: -1 };

/* ── Lectura de la hoja de ventas (funciones de lectura en core/sheets.js) ── */

/* Por cada número de operador, la fila con MÁS Órdenes Únicas */
function olBuildSheetIndex(table) {
  if (!table.length) throw new Error('La hoja de ventas llegó vacía.');
  const header = table[0];
  const C = {
    op: sheetColumn(header, 'Operator'), uo: sheetColumn(header, 'Unique Orders'), total: sheetColumn(header, 'Total'),
    approve: sheetColumn(header, 'Approve'), reject: sheetColumn(header, 'Reject'), trash: sheetColumn(header, 'Trash'),
    recall: sheetColumn(header, 'Recall'), noAnswer: sheetColumn(header, 'No answer'),
  };
  if (C.op < 0 || C.uo < 0 || C.approve < 0) {
    throw new Error('La hoja de ventas no tiene las columnas esperadas (Operator, Unique Orders, Approve…). ¿Cambió el formato?');
  }
  const get = (r, i) => (i >= 0 ? sheetNum(r[i]) : 0);

  const best = new Map();
  let unnamedRows = 0, dupResolved = 0;
  table.slice(1).forEach(r => {
    const num = sheetOperatorNumber(r[C.op]);
    if (!num) {
      if (get(r, C.uo) > 0 || get(r, C.total) > 0) unnamedRows++;   // tiene datos pero no se sabe de quién
      return;
    }
    const rec = {
      sheetOperator: String(r[C.op]).trim(),
      uniqueOrders: get(r, C.uo), total: get(r, C.total), approve: get(r, C.approve),
      reject: get(r, C.reject), trash: get(r, C.trash), recall: get(r, C.recall), noAnswer: get(r, C.noAnswer),
    };
    const prev = best.get(num);
    if (prev) dupResolved++;
    if (!prev || rec.uniqueOrders > prev.uniqueOrders) best.set(num, rec);
  });
  return { best, unnamedRows, dupResolved };
}

/* ── Carga ── */
async function olInitView() {
  olLoaded = true;
  document.getElementById('ol-sheet-link').href = OL_SHEET_VIEW_URL;
  document.getElementById('ol-att-link').href = ATT_SHEET_VIEW_URL;
  await olLoad();
}

async function olLoad(silent = false) {
  if (olBusy) return;
  olBusy = true;
  const btn = document.getElementById('ol-refresh-btn');
  const errBox = document.getElementById('ol-error');
  btn.disabled = true;
  btn.classList.add('ol-spin');
  if (!silent) errBox.hidden = true;

  try {
    // Ventas + distribución + asistencia en paralelo. Sin asistencia no se puede filtrar: es obligatoria.
    const [salesTable, disRows, att] = await Promise.all([
      sheetFetchCsv(OL_SHEET_CSV_URL, 'ventas'),
      sbFetch('dt_dis', 'select=PEROP1AM,ASESORES,TEAMLEADER,PAIS,HORARIO').catch(() => {
        throw new Error('No se pudo leer la distribución (GoodDay) desde Supabase. Intenta de nuevo o vuelve a iniciar sesión.');
      }),
      attFetch(true),
    ]);
    const { best, unnamedRows, dupResolved } = olBuildSheetIndex(salesTable);

    const seen = new Set();
    const matched = new Set();
    let distTotal = 0;
    olRows = [];
    (disRows || []).forEach(d => {
      const num = sheetOperatorNumber(d.PEROP1AM);
      if (!num || seen.has(num)) return;
      seen.add(num);
      distTotal++;
      // Solo los OPs que asistieron: "A" en la hoja de asistencia
      if (!attIsPresent(att.map.get(num))) return;
      const s = best.get(num);
      if (s) matched.add(num);
      olRows.push({
        perop: (d.PEROP1AM || '').trim(), num,
        asesor: d.ASESORES || '—', teamLeader: d.TEAMLEADER || '—', pais: d.PAIS || '—', horario: d.HORARIO || '—',
        hasData: !!s,
        sheetOperator: s ? s.sheetOperator : '',
        uniqueOrders: s ? s.uniqueOrders : 0, total: s ? s.total : 0, approve: s ? s.approve : 0,
        reject: s ? s.reject : 0, trash: s ? s.trash : 0, recall: s ? s.recall : 0, noAnswer: s ? s.noAnswer : 0,
        approvePct: s && s.uniqueOrders > 0 ? (s.approve / s.uniqueOrders) * 100 : null,
      });
    });

    olMeta = {
      fetchedAt: new Date().toISOString(),
      sheetOps: best.size,
      dupResolved,
      unnamedRows,
      distTotal,
      present: olRows.length,
    };
    errBox.hidden = true;
    olRenderAll();
  } catch (err) {
    console.error('Error cargando Stats OPs Live:', err);
    errBox.textContent = (err && err.message) ? err.message : 'No se pudo cargar la información, intenta de nuevo.';
    errBox.hidden = false;
  } finally {
    olBusy = false;
    btn.disabled = false;
    btn.classList.remove('ol-spin');
  }
}

/* ── Filtros y cálculos ── */
function olIsPostSale(horario) { return (horario || '').includes('09:00'); }  // mismo criterio que Stats OPs Today

function olScopeRows() {
  const wantPostSale = olCampaignMode === 'postsale';
  return olRows.filter(r => olIsPostSale(r.horario) === wantPostSale);
}

function olSetCampaignMode(mode) {
  if (olCampaignMode === mode) return;
  olCampaignMode = mode;
  document.querySelectorAll('.ol-campaign-btn').forEach(b => {
    const active = b.dataset.mode === mode;
    b.classList.toggle('btn-primary', active);
    b.classList.toggle('btn-ghost', !active);
  });
  document.getElementById('ol-f-tl').value = '';
  document.getElementById('ol-f-pais').value = '';
  olRenderAll();
}

function olPct(approve, uniqueOrders) {
  return uniqueOrders > 0 ? `${((approve / uniqueOrders) * 100).toFixed(1)}%` : '—';
}
function olFmt(n) { return Number(n || 0).toLocaleString('es-PE'); }

/* ── Render ── */
function olRenderAll() {
  if (!olMeta) return;
  olRenderUpdated();
  olRenderNote();
  olRenderKPIs();
  olRenderTop();
  olRenderTlSummary();
  olPopulateFilters();
  olRenderDetail();
}

function olRenderUpdated() {
  const el = document.getElementById('ol-updated');
  el.textContent = olMeta ? `Actualizado ${repTimeAgo(olMeta.fetchedAt)}` : '';
}
// El "hace X minutos" se mantiene al día solo
setInterval(() => { if (currentPage === 'opslive' && olMeta) olRenderUpdated(); }, 30 * 1000);

function olRenderNote() {
  const m = olMeta;
  const parts = [
    `${m.present} de ${m.distTotal} OPs de la distribución con asistencia "A"`,
    `${m.sheetOps} operadores en la hoja de ventas`,
    `${m.dupResolved} fila${m.dupResolved === 1 ? '' : 's'} repetida${m.dupResolved === 1 ? '' : 's'} (se tomó la de más órdenes únicas)`,
  ];
  if (m.unnamedRows) parts.push(`${m.unnamedRows} filas con datos pero sin operador (no se pueden asignar)`);
  document.getElementById('ol-note').textContent = parts.join(' · ');
}

function olRenderKPIs() {
  const scope = olScopeRows();
  const active = scope.filter(r => r.hasData);
  const sum = k => active.reduce((s, r) => s + r[k], 0);
  const uo = sum('uniqueOrders'), ap = sum('approve'), rj = sum('reject'), tr = sum('trash');
  const cards = [
    { label: 'OPs con actividad', value: `${active.length}`, sub: `de ${scope.length} que asistieron (A)` },
    { label: 'Órdenes únicas', value: olFmt(uo) },
    { label: 'Ventas (Approve)', value: olFmt(ap), cls: 'ol-kpi-green' },
    { label: '% Approve', value: olPct(ap, uo), sub: 'ventas ÷ órdenes únicas' },
    { label: 'Reject', value: olFmt(rj), cls: 'ol-kpi-red' },
    { label: 'Trash', value: olFmt(tr), cls: 'ol-kpi-amber' },
  ];
  document.getElementById('ol-kpis').innerHTML = cards.map(c => `
    <div class="kpi-card">
      <div class="kpi-header"><span class="kpi-label">${c.label}</span></div>
      <div class="kpi-value ${c.cls || ''}">${escapeHtml(c.value)}</div>
      ${c.sub ? `<span class="kpi-sub">${c.sub}</span>` : ''}
    </div>`).join('');
}

function olOperatorCell(r) {
  return `<div class="ol-op-name" title="${escapeHtml(r.asesor)}">${escapeHtml(r.asesor)}</div>
          <div class="ol-sub">${escapeHtml(r.perop)}</div>`;
}

function olRenderTop() {
  const box = document.getElementById('ol-top');
  const top = olScopeRows().filter(r => r.hasData)
    .sort((a, b) => (b.approve - a.approve) || ((b.approvePct ?? 0) - (a.approvePct ?? 0)))
    .slice(0, OL_TOP_N);
  if (top.length === 0) {
    box.innerHTML = `<div class="gd-state pad-30"><p>Sin actividad todavía para este tipo de campaña</p><small>Solo se cuentan los OPs marcados con "A" en la hoja de asistencia</small></div>`;
    return;
  }
  box.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th></th><th>Operador</th><th>Team Leader</th><th>Campaña</th><th class="ol-num">Ventas</th><th class="ol-num">% Approve</th></tr></thead>
    <tbody>${top.map((r, i) => `<tr>
      <td class="ol-rank">${i + 1}</td>
      <td>${olOperatorCell(r)}</td>
      <td class="ol-nowrap">${recTlBadge(r.teamLeader)}</td>
      <td class="ol-nowrap">${countryFlag(r.pais)}${escapeHtml(r.pais)}</td>
      <td class="ol-num ol-sales ol-big">${olFmt(r.approve)}</td>
      <td class="ol-num">${olPct(r.approve, r.uniqueOrders)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function olRenderTlSummary() {
  const box = document.getElementById('ol-tl-summary');
  const byTl = new Map();
  olScopeRows().forEach(r => {
    if (!r.teamLeader || r.teamLeader === '—') return;
    const t = byTl.get(r.teamLeader) || { teamLeader: r.teamLeader, ops: 0, active: 0, uniqueOrders: 0, approve: 0 };
    t.ops++;
    if (r.hasData) { t.active++; t.uniqueOrders += r.uniqueOrders; t.approve += r.approve; }
    byTl.set(r.teamLeader, t);
  });
  const list = [...byTl.values()].sort((a, b) => b.approve - a.approve);
  if (list.length === 0) {
    box.innerHTML = `<div class="gd-state pad-30"><p>Sin Team Leaders para este tipo de campaña</p></div>`;
    return;
  }
  box.innerHTML = `<div class="tbl-wrap"><table>
    <thead><tr><th>Team Leader</th><th class="ol-num">OPs</th><th class="ol-num">Ventas</th><th class="ol-num">% Approve</th></tr></thead>
    <tbody>${list.map(t => `<tr>
      <td class="ol-nowrap">${recTlBadge(t.teamLeader)}</td>
      <td class="ol-num">${t.active}<span class="ol-sub">/${t.ops}</span></td>
      <td class="ol-num ol-sales">${olFmt(t.approve)}</td>
      <td class="ol-num">${olPct(t.approve, t.uniqueOrders)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function olPopulateFilters() {
  const scope = olScopeRows();
  const fill = (id, values) => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '<option value="">Todos</option>' +
      values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if (prev && values.includes(prev)) sel.value = prev;
  };
  const uniq = key => [...new Set(scope.map(r => r[key]).filter(v => v && v !== '—'))].sort();
  fill('ol-f-tl', uniq('teamLeader'));
  fill('ol-f-pais', uniq('pais'));
}

function olFilteredRows() {
  const tl = document.getElementById('ol-f-tl').value;
  const pais = document.getElementById('ol-f-pais').value;
  const q = document.getElementById('ol-search').value.trim().toLowerCase();
  const showInactive = document.getElementById('ol-show-inactive').checked;
  return olScopeRows().filter(r => {
    if (!showInactive && !r.hasData) return false;
    if (tl && r.teamLeader !== tl) return false;
    if (pais && r.pais !== pais) return false;
    if (q && !`${r.asesor} ${r.perop} ${r.teamLeader}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function olSortBy(key) {
  olSort = olSort.key === key ? { key, dir: -olSort.dir } : { key, dir: typeof olRows[0]?.[key] === 'string' ? 1 : -1 };
  olRenderDetail();
}

function olRenderDetail() {
  // Pills de filtro resaltadas cuando tienen un valor elegido (mismo estilo que GoodDay)
  ['ol-f-tl', 'ol-f-pais'].forEach(id => {
    const sel = document.getElementById(id);
    sel.closest('.gd-filter-pill').classList.toggle('active', !!sel.value);
  });
  document.getElementById('ol-search').closest('.gd-search-wrap')
    .classList.toggle('active', !!document.getElementById('ol-search').value.trim());

  const rows = olFilteredRows();
  const { key, dir } = olSort;
  rows.sort((a, b) => {
    const va = a[key] ?? -1, vb = b[key] ?? -1;
    const c = typeof va === 'string' ? va.localeCompare(vb) : va - vb;
    return c * dir;
  });

  document.getElementById('ol-detail-count').textContent = `(${rows.length})`;
  document.querySelectorAll('#ol-table thead th[data-key]').forEach(th => {
    const on = th.dataset.key === key;
    th.classList.toggle('sorted', on);
    th.querySelector('.sort-icon').textContent = on ? (dir > 0 ? '↑' : '↓') : '↕';
  });

  const table = document.getElementById('ol-table');
  const empty = document.getElementById('ol-detail-empty');
  if (rows.length === 0) { table.hidden = true; empty.hidden = false; return; }
  table.hidden = false;
  empty.hidden = true;

  // Intensidad del verde según ventas, relativa al mejor de la lista visible
  const maxAp = Math.max(1, ...rows.map(r => r.approve));
  document.getElementById('ol-tbody').innerHTML = rows.map(r => {
    const heat = r.hasData && r.approve > 0 ? `style="background:rgba(34,197,94,${(0.06 + (r.approve / maxAp) * 0.36).toFixed(3)})"` : '';
    return `<tr class="${r.hasData ? '' : 'ol-inactive'}">
      <td class="ol-nowrap">${recTlBadge(r.teamLeader)}</td>
      <td>${olOperatorCell(r)}</td>
      <td class="ol-nowrap">${countryFlag(r.pais)}${escapeHtml(r.pais)}</td>
      <td class="ol-nowrap">${gdScheduleBadge(r.horario)}</td>
      <td class="ol-num">${r.hasData ? olFmt(r.uniqueOrders) : '—'}</td>
      <td class="ol-num ol-sales ol-big" ${heat}>${r.hasData ? olFmt(r.approve) : '—'}</td>
      <td class="ol-num">${r.hasData ? olPct(r.approve, r.uniqueOrders) : '—'}</td>
      <td class="ol-num">${r.hasData ? olFmt(r.reject) : '—'}</td>
      <td class="ol-num">${r.hasData ? olFmt(r.trash) : '—'}</td>
      <td class="ol-num">${r.hasData ? olFmt(r.recall) : '—'}</td>
    </tr>`;
  }).join('');
}

function olClearFilters() {
  document.getElementById('ol-f-tl').value = '';
  document.getElementById('ol-f-pais').value = '';
  document.getElementById('ol-search').value = '';
  document.getElementById('ol-show-inactive').checked = false;
  olRenderDetail();
}
