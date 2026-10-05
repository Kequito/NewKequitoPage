/* Sección SEGUIMIENTO — exclusiva de la cuenta Admin (grupo "🧪 Laboratorio").
   Este archivo se descarga SOLO cuando esa cuenta abre la sección (core/nav.js → adminLoadView), y trae
   su propio HTML y CSS. Los datos los entrega Supabase solo a la cuenta Admin (seg_get, script 10).

   Lo que se ve: por cada cuenta, su línea de tiempo del día pintada por estado
   (🟢 activo · 🟡 inactivo · ⚪ en otra pestaña · vacío = desconectado), totales, primera y última
   conexión, y una ficha con dónde pasó el tiempo, interacción por hora y los últimos 7 días.
   Los registra core/tracking.js en todas las cuentas. */

const SEG_SLOT_MS   = 15 * 1000;          // resolución de la línea de tiempo: 15 segundos
const SEG_ONLINE_MS = 150 * 1000;         // último aviso hace menos de esto = "en línea"
const SEG_RANK = { oculto: 1, inactivo: 2, activo: 3 };   // si hay 2 pestañas a la vez, gana el mejor estado
const SEG_STATES = [
  { rank: 3, key: 'activo',   label: 'Activo',          cls: 'seg-activo' },
  { rank: 2, key: 'inactivo', label: 'Inactivo',        cls: 'seg-inactivo' },
  { rank: 1, key: 'oculto',   label: 'En otra pestaña', cls: 'seg-oculto' },
];

let segLoaded = false;
let segBusy = false;
let segDay = segDayStart(new Date());
let segData = null;      // { ahora, desde, hasta, cuentas, tramos } del día elegido
let segPeople = [];      // una entrada por cuenta, ya calculada
let segCargo = '';
let segSort = 'activo';
let segShowAll = false;

/* ══════════════════════════════
   FECHAS Y FORMATOS
══════════════════════════════ */
function segDayStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function segAddDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function segIsToday() { return segDay.getTime() === segDayStart(new Date()).getTime(); }
function segIsoDate(d) { const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function segFmtTime(ms) { return new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }); }
function segFmtDur(ms) {
  const m = Math.round(ms / 60000);
  if (m < 1) return ms > 0 ? '<1 min' : '0 min';
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}
function segDayLabel(d, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  const s = d.toLocaleDateString('es-PE', opts);
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function segSectionLabel(s) { return (titleMap[s] && titleMap[s][0]) || s || 'Sin sección'; }

/* ══════════════════════════════
   CÁLCULO — tramos → línea de tiempo por cuenta
══════════════════════════════ */
function segParseTramos(raw) {
  // [codigo, estado, seccion, inicio, fin, clics, teclas, pestana]
  return (raw || []).map(t => ({
    codigo: t[0], estado: t[1], seccion: t[2] || '', inicio: new Date(t[3]).getTime(), fin: new Date(t[4]).getTime(),
    clics: Number(t[5]) || 0, teclas: Number(t[6]) || 0,
  }));
}

/* Una cuenta en el rango [desde, hasta): casillas de 15 s con el mejor estado, totales y datos de la ficha */
function segBuildPerson(acc, tramos, desde, hasta, ahora) {
  const n = Math.ceil((hasta - desde) / SEG_SLOT_MS);
  const slots = new Uint8Array(n);
  const bySection = {};
  const byHour = new Array(24).fill(0);
  let first = null, last = null, clics = 0, teclas = 0, latest = null;

  tramos.forEach(t => {
    const i0 = Math.max(t.inicio, desde), i1 = Math.min(t.fin, hasta);
    if (i1 < i0) return;
    const a = Math.floor((i0 - desde) / SEG_SLOT_MS);
    const b = Math.min(n, Math.max(a + 1, Math.ceil((i1 - desde) / SEG_SLOT_MS)));
    const r = SEG_RANK[t.estado] || 0;
    for (let i = a; i < b; i++) if (slots[i] < r) slots[i] = r;
    if (t.estado !== 'oculto') bySection[t.seccion] = (bySection[t.seccion] || 0) + (i1 - i0);
    clics += t.clics;
    teclas += t.teclas;
    byHour[new Date((i0 + i1) / 2).getHours()] += t.clics + t.teclas;
    first = first === null ? i0 : Math.min(first, i0);
    last = last === null ? i1 : Math.max(last, i1);
    if (!latest || t.fin > latest.fin) latest = t;
  });

  const ms = { 1: 0, 2: 0, 3: 0 };
  const runs = [];
  for (let i = 0; i < n; i++) {
    const r = slots[i];
    if (r) ms[r] += SEG_SLOT_MS;
    if (runs.length && runs[runs.length - 1].rank === r) runs[runs.length - 1].b = i + 1;
    else runs.push({ rank: r, a: i, b: i + 1 });
  }
  const online = latest && ahora - latest.fin < SEG_ONLINE_MS ? latest.estado : null;
  return {
    codigo: acc.c, nombre: acc.n, cargo: acc.r, perop: acc.p, genero: acc.g,
    desde, activo: ms[3], inactivo: ms[2], oculto: ms[1], total: ms[1] + ms[2] + ms[3],
    runs: runs.filter(r => r.rank > 0), first, last, clics, teclas, bySection, byHour, online,
    hasData: first !== null,
  };
}

function segBuildAll() {
  if (!segData) { segPeople = []; return; }
  const byCode = new Map();
  segData.tramos.forEach(t => { if (!byCode.has(t.codigo)) byCode.set(t.codigo, []); byCode.get(t.codigo).push(t); });
  segPeople = segData.cuentas.map(acc => segBuildPerson(acc, byCode.get(acc.c) || [], segData.desde, segData.hasta, segData.ahora));
}

/* Eje de horas: 06:00–24:00, o desde antes si alguien se conectó más temprano */
function segAxis(people) {
  const firsts = people.filter(p => p.hasData).map(p => new Date(p.first).getHours());
  const start = Math.min(6, ...firsts);
  return { start, end: 24, hours: 24 - start };
}

/* ══════════════════════════════
   CARGA
══════════════════════════════ */
async function segOpenView() {
  segInjectStyle();
  segEnsureView();
  if (!segLoaded) { segLoaded = true; await segLoad(); }
  else await segLoad(true);
}

async function segRefresh() { if (segLoaded && currentPage === 'seguimiento') await segLoad(true); }

async function segLoad(silent = false) {
  if (segBusy) return;
  segBusy = true;
  const btn = document.getElementById('seg-refresh-btn');
  const err = document.getElementById('seg-error');
  btn.disabled = true;
  btn.classList.add('ol-spin');
  if (!silent && !segData) document.getElementById('seg-board').innerHTML = '<div class="seg-empty">Cargando…</div>';
  try {
    const desde = segDay.getTime(), hasta = segAddDays(segDay, 1).getTime();
    const data = await sbRpc('seg_get', { p_desde: new Date(desde).toISOString(), p_hasta: new Date(hasta).toISOString() });
    segData = { ahora: new Date(data.ahora).getTime(), desde, hasta, cuentas: data.cuentas || [], tramos: segParseTramos(data.tramos) };
    err.hidden = true;
    segBuildAll();
    segRender();
    document.getElementById('seg-updated').textContent = `Actualizado ${segFmtTime(Date.now())}`;
  } catch (e) {
    console.error('Error cargando Seguimiento:', e);
    err.textContent = /seg_get/.test(e.message || '')
      ? 'Falta correr en Supabase el script 10 (Admin y Seguimiento).'
      : (e.message || 'No se pudo cargar el seguimiento, intenta de nuevo.');
    err.hidden = false;
  } finally {
    segBusy = false;
    btn.disabled = false;
    btn.classList.remove('ol-spin');
  }
}

function segSetDate(value) {
  if (!value) return;
  const d = segDayStart(new Date(`${value}T00:00:00`));
  if (d > segDayStart(new Date())) return;
  segDay = d;
  segData = null;
  segLoad();
}
function segShiftDay(n) {
  const d = segAddDays(segDay, n);
  if (d > segDayStart(new Date())) return;
  segSetDate(segIsoDate(d));
}
function segGoToday() { segSetDate(segIsoDate(new Date())); }
function segSetCargo(c) { segCargo = c; segRender(); }

/* ══════════════════════════════
   RENDER
══════════════════════════════ */
function segFiltered() {
  const q = (document.getElementById('seg-search').value || '').trim().toLowerCase();
  const list = segPeople.filter(p =>
    (segShowAll || p.hasData) &&
    (!segCargo || p.cargo === segCargo) &&
    (!q || `${p.nombre} ${p.codigo} ${p.perop}`.toLowerCase().includes(q)));
  const sorters = {
    activo:  (a, b) => (b.activo - a.activo) || a.nombre.localeCompare(b.nombre),
    online:  (a, b) => ((b.online ? SEG_RANK[b.online] : 0) - (a.online ? SEG_RANK[a.online] : 0)) || (b.activo - a.activo),
    primera: (a, b) => ((a.first ?? Infinity) - (b.first ?? Infinity)) || a.nombre.localeCompare(b.nombre),
    nombre:  (a, b) => a.nombre.localeCompare(b.nombre),
  };
  return list.sort(sorters[segSort] || sorters.activo);
}

function segRender() {
  if (!segData) return;
  const today = segIsToday();
  document.getElementById('seg-date').value = segIsoDate(segDay);
  document.getElementById('seg-date').max = segIsoDate(new Date());
  document.getElementById('seg-next').disabled = today;
  document.getElementById('seg-daylabel').textContent = `· ${segDayLabel(segDay)}${today ? ' (hoy)' : ''}`;
  document.getElementById('seg-search').closest('.gd-search-wrap').classList.toggle('active', !!document.getElementById('seg-search').value.trim());

  const cargos = ['Supervisor', 'Team Leader', 'Operador'];
  document.getElementById('seg-cargo-seg').innerHTML = [['', 'Todos'], ...cargos.map(c => [c, ACCT_CARGO_PLURAL ? (ACCT_CARGO_PLURAL[c] || c) : c])]
    .map(([v, l]) => `<button type="button" class="eq-seg-btn ${segCargo === v ? 'active' : ''}" onclick="segSetCargo(${jsArg(v)})">${escapeHtml(l)}</button>`).join('');

  segRenderKPIs(today);
  const list = segFiltered();
  const board = document.getElementById('seg-board');
  if (!list.length) {
    board.innerHTML = `<div class="seg-empty">${segPeople.some(p => p.hasData)
      ? 'Nadie coincide con los filtros.'
      : `Nadie se conectó ${today ? 'todavía hoy' : 'este día'}${segShowAll ? '' : ' — marca "Mostrar quienes no se conectaron" para ver a todos'}.`}</div>`;
    return;
  }
  const axis = segAxis(segPeople);
  board.innerHTML = `<div class="seg-row seg-row-head"><div class="seg-h">Cuenta</div>${segScaleHTML(axis)}<div class="seg-h">Tiempo del día</div></div>`
    + list.map(p => segRowHTML(p, axis, today)).join('');
}

function segRenderKPIs(today) {
  const conn = segPeople.filter(p => p.hasData);
  const online = segPeople.filter(p => p.online);
  const onlineAct = online.filter(p => p.online === 'activo').length;
  const totalAct = conn.reduce((s, p) => s + p.activo, 0);
  const best = [...conn].sort((a, b) => b.activo - a.activo)[0];
  const cards = [
    { icon: '🟢', label: 'En línea ahora', value: today ? online.length : '—', sub: today ? `${onlineAct} activo${onlineAct === 1 ? '' : 's'} · ${online.length - onlineAct} inactivo / otra pestaña` : 'solo para el día de hoy', tone: today && online.length ? 'good' : 'neutral' },
    { icon: '👥', label: 'Se conectaron', value: `${conn.length}<span class="dash-kpi-of">/${segPeople.length}</span>`, sub: 'cuentas con algún registro este día', tone: 'neutral' },
    { icon: '⏱', label: 'Activo promedio', value: conn.length ? segFmtDur(totalAct / conn.length) : '—', sub: `entre los que se conectaron · total ${segFmtDur(totalAct)}`, tone: 'neutral' },
    { icon: '🏅', label: 'Más tiempo activo', value: best ? escapeHtml(best.nombre.split(' ')[0]) : '—', sub: best ? `${escapeHtml(best.nombre)} · ${segFmtDur(best.activo)}` : 'nadie todavía', tone: 'neutral' },
  ];
  const el = document.getElementById('seg-kpis');
  el.style.setProperty('--n', cards.length);
  el.innerHTML = cards.map(c => `<div class="dash-kpi dash-kpi--${c.tone} seg-kpi">
      <span class="dash-kpi-head"><span class="dash-kpi-icon">${c.icon}</span><span class="dash-kpi-label">${c.label}</span></span>
      <span class="dash-kpi-row"><span class="dash-kpi-value">${c.value}</span></span>
      <span class="dash-kpi-sub">${c.sub}</span>
    </div>`).join('');
}

function segScaleHTML(axis, every = 0) {
  const step = every || (axis.hours > 14 ? 2 : 1);
  let html = '';
  for (let h = axis.start; h <= axis.end; h += step) {
    html += `<span style="left:${((h - axis.start) / axis.hours) * 100}%">${String(h % 24).padStart(2, '0')}:00</span>`;
  }
  return `<div class="seg-scale">${html}</div>`;
}

/* Barra del día: tramos pintados por estado sobre la cuadrícula de horas, y la marca de "ahora" */
function segTrackHTML(p, axis, big = false) {
  const off = axis.start * 3600000, span = axis.hours * 3600000;
  const runs = p.runs.map(r => {
    const from = r.a * SEG_SLOT_MS, to = r.b * SEG_SLOT_MS;
    if (to <= off) return '';
    const left = ((Math.max(from, off) - off) / span) * 100;
    const width = ((to - Math.max(from, off)) / span) * 100;
    const st = SEG_STATES.find(s => s.rank === r.rank);
    const tip = `${segFmtTime(p.desde + from)}–${segFmtTime(p.desde + to)} · ${st.label} (${segFmtDur(to - from)})`;
    return `<span class="seg-run ${st.cls}" style="left:${left.toFixed(3)}%;width:${width.toFixed(3)}%" title="${tip}"></span>`;
  }).join('');
  let now = '';
  if (segIsToday()) {
    const pos = ((segData.ahora - p.desde - off) / span) * 100;
    if (pos > 0 && pos < 100) now = `<span class="seg-now" style="left:${pos.toFixed(2)}%" title="Ahora"></span>`;
  }
  return `<div class="seg-track ${big ? 'seg-track-lg' : ''}" style="--hours:${axis.hours}">${runs}${now}</div>`;
}

function segOnlineBadge(p) {
  if (!p.online) return '';
  const st = SEG_STATES.find(s => s.key === p.online);
  return `<span class="seg-online seg-online--${p.online}" title="Último aviso hace menos de 3 minutos">● ${p.online === 'activo' ? 'En línea' : st.label}</span>`;
}

function segRowHTML(p, axis) {
  return `<div class="seg-row" role="button" tabindex="0" onclick="segOpenPerson(${jsArg(p.codigo)})" onkeydown="if(event.key==='Enter')segOpenPerson(${jsArg(p.codigo)})">
    <div class="seg-who">${silhouetteHTML(p.genero, 'acct-avatar')}
      <div class="seg-id">
        <div class="seg-name" title="${escapeHtml(p.nombre)}">${escapeHtml(p.nombre)}</div>
        <div class="seg-sub"><span class="acct-code">${escapeHtml(p.codigo)}</span>${escapeHtml(p.cargo || '')}${segOnlineBadge(p)}</div>
      </div>
    </div>
    ${segTrackHTML(p, axis)}
    <div class="seg-stats">${p.hasData
      ? `<span><strong>${segFmtDur(p.activo)}</strong> activo</span>
         <span>${segFmtDur(p.inactivo)} inactivo · ${segFmtDur(p.oculto)} otra pestaña</span>
         <span class="seg-times">${segFmtTime(p.first)} → ${segFmtTime(p.last)}</span>`
      : '<span class="seg-off-txt">No se conectó</span>'}</div>
  </div>`;
}

/* ══════════════════════════════
   FICHA DE UNA CUENTA
══════════════════════════════ */
function segTile(label, value, sub = '') {
  return `<div class="seg-tile"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
}

async function segOpenPerson(codigo) {
  const p = segPeople.find(x => x.codigo === codigo);
  if (!p) return;
  const axis = segAxis([p]);
  const sections = Object.entries(p.bySection).sort((a, b) => b[1] - a[1]);
  const maxSec = Math.max(1, ...sections.map(s => s[1]));
  const hours = [];
  for (let h = axis.start; h < 24; h++) hours.push(h);
  const maxHour = Math.max(1, ...hours.map(h => p.byHour[h]));

  const body = uiEl('div', 'seg-detail');
  body.innerHTML = `
    <div class="seg-dhead">${silhouetteHTML(p.genero, 'acct-card-avatar')}
      <div><div class="acct-card-name">${escapeHtml(p.nombre)}</div>
      <div class="acct-card-badges"><span class="acct-code">${escapeHtml(p.codigo)}</span>${acctCargoBadge(p.cargo)}${segOnlineBadge(p)}</div></div>
      <div class="seg-dday">${escapeHtml(segDayLabel(segDay))}</div>
    </div>
    <div class="seg-tiles">
      ${segTile('🟢 Activo', segFmtDur(p.activo))}
      ${segTile('🟡 Inactivo', segFmtDur(p.inactivo), 'página abierta sin tocar')}
      ${segTile('⚪ Otra pestaña', segFmtDur(p.oculto), 'minimizada o detrás')}
      ${segTile('🕘 Conexión', p.hasData ? `${segFmtTime(p.first)} → ${segFmtTime(p.last)}` : '—')}
      ${segTile('🖱 Clics', p.clics.toLocaleString('es-PE'))}
      ${segTile('⌨ Teclas', p.teclas.toLocaleString('es-PE'), 'solo la cantidad')}
    </div>
    <div class="seg-dsec">Línea de tiempo</div>
    ${segScaleHTML(axis, 1)}${segTrackHTML(p, axis, true)}
    <div class="seg-legend seg-legend-sm">${segLegendHTML()}</div>
    <div class="seg-dcols">
      <div>
        <div class="seg-dsec">Dónde pasó el tiempo <small>(activo + inactivo)</small></div>
        ${sections.length ? sections.map(([s, ms]) => `<div class="seg-bar-row"><span>${escapeHtml(segSectionLabel(s))}</span>
          <span class="seg-bar-track"><i style="width:${((ms / maxSec) * 100).toFixed(1)}%"></i></span><span class="seg-bar-val">${segFmtDur(ms)}</span></div>`).join('')
          : '<div class="seg-empty-sm">Sin registros este día</div>'}
      </div>
      <div>
        <div class="seg-dsec">Interacción por hora <small>(clics + teclas)</small></div>
        <div class="seg-hours">${hours.map(h => `<div class="seg-hour" title="${String(h).padStart(2, '0')}:00 — ${p.byHour[h]} clics + teclas">
          <i style="height:${((p.byHour[h] / maxHour) * 100).toFixed(1)}%"></i><span>${h % 2 === 0 ? String(h).padStart(2, '0') : ''}</span></div>`).join('')}</div>
      </div>
    </div>
    <div class="seg-dsec">Últimos 7 días</div>
    <div class="seg-week" id="seg-week-${escapeHtml(p.codigo)}"><div class="seg-empty-sm">Cargando…</div></div>`;

  segLoadWeek(p, body.querySelector('.seg-week'));
  await uiDialog({ title: 'Seguimiento de la cuenta', body, wide: true, confirmText: 'Cerrar', cancelText: null });
}

async function segLoadWeek(p, box) {
  try {
    const desde = segAddDays(segDay, -6), hasta = segAddDays(segDay, 1);
    const data = await sbRpc('seg_get', { p_desde: desde.toISOString(), p_hasta: hasta.toISOString(), p_codigo: p.codigo });
    const tramos = segParseTramos(data.tramos);
    const acc = (data.cuentas || [])[0] || { c: p.codigo, n: p.nombre };
    const ahora = new Date(data.ahora).getTime();
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d0 = segAddDays(desde, i);
      days.push({ d: d0, p: segBuildPerson(acc, tramos, d0.getTime(), segAddDays(d0, 1).getTime(), ahora) });
    }
    const max = Math.max(1, ...days.map(x => x.p.total));
    box.innerHTML = days.map(({ d, p: x }) => `<div class="seg-bar-row seg-week-row">
      <span>${escapeHtml(segDayLabel(d, { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', ''))}</span>
      <span class="seg-bar-track seg-week-track" title="Activo ${segFmtDur(x.activo)} · Inactivo ${segFmtDur(x.inactivo)} · Otra pestaña ${segFmtDur(x.oculto)}">
        <i class="seg-activo" style="width:${((x.activo / max) * 100).toFixed(1)}%"></i><i class="seg-inactivo" style="width:${((x.inactivo / max) * 100).toFixed(1)}%"></i><i class="seg-oculto" style="width:${((x.oculto / max) * 100).toFixed(1)}%"></i>
      </span>
      <span class="seg-bar-val">${x.hasData ? `<strong>${segFmtDur(x.activo)}</strong> activo` : '<span class="seg-off-txt">—</span>'}</span>
    </div>`).join('');
  } catch (e) {
    console.error('Seguimiento — últimos 7 días:', e);
    box.innerHTML = '<div class="seg-empty-sm">No se pudieron cargar los últimos 7 días.</div>';
  }
}

function segLegendHTML() {
  return SEG_STATES.map(s => `<span><i class="${s.cls}"></i>${s.label}</span>`).join('') + '<span><i class="seg-off"></i>Desconectado</span>';
}

/* ══════════════════════════════
   HTML Y CSS PROPIOS (no están en index.html ni en los CSS públicos)
══════════════════════════════ */
function segEnsureView() {
  let v = document.getElementById('view-seguimiento');
  if (!v) {
    v = document.createElement('div');
    v.className = 'view';
    v.id = 'view-seguimiento';
    v.innerHTML = `
    <div class="panel mb-22 clip">
      <div class="gd-infobar">
        <div class="gd-infobar-title">
          <svg viewBox="0 0 24 24" fill="currentColor" class="ico-16"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>
          Seguimiento
          <span class="seg-lab-tag">🧪 Laboratorio · solo tú</span>
        </div>
        <div class="ol-actions">
          <span id="seg-updated" class="ol-updated"></span>
          <button id="seg-refresh-btn" class="btn btn-primary btn-sm" type="button" onclick="segLoad()">↻ Actualizar</button>
        </div>
      </div>
      <div class="toolbar-row eq-toolbar">
        <div class="seg-datenav">
          <button type="button" class="btn btn-ghost btn-sm" onclick="segShiftDay(-1)" title="Día anterior" aria-label="Día anterior">◀</button>
          <input type="date" id="seg-date" onchange="segSetDate(this.value)" aria-label="Día"/>
          <button type="button" class="btn btn-ghost btn-sm" id="seg-next" onclick="segShiftDay(1)" title="Día siguiente" aria-label="Día siguiente">▶</button>
          <button type="button" class="btn btn-ghost btn-sm" onclick="segGoToday()">Hoy</button>
        </div>
        <div class="eq-seg" id="seg-cargo-seg" aria-label="Cargo"></div>
        <div class="gd-search-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input type="search" id="seg-search" placeholder="Buscar cuenta o código…" oninput="segRender()" aria-label="Buscar cuenta"/>
        </div>
        <select id="seg-sort" class="form-select-sm" onchange="segSort=this.value;segRender()" aria-label="Orden">
          <option value="activo">Más tiempo activo</option>
          <option value="online">En línea primero</option>
          <option value="primera">Primera conexión</option>
          <option value="nombre">Nombre</option>
        </select>
        <label class="eq-check"><input type="checkbox" id="seg-show-all" onchange="segShowAll=this.checked;segRender()"/> Mostrar quienes no se conectaron</label>
      </div>
    </div>

    <div class="dash-kpis mb-22" id="seg-kpis"></div>

    <div class="panel mb-22 clip">
      <div class="panel-head">
        <span class="panel-title">Línea de tiempo del día <span id="seg-daylabel" class="muted-normal"></span></span>
        <div class="seg-legend">${segLegendHTML()}</div>
      </div>
      <div id="seg-error" class="ol-error" role="alert" hidden></div>
      <div class="seg-board" id="seg-board"></div>
      <div class="eq-tbl-foot">Clic en una cuenta para ver su detalle · pasa el mouse sobre la barra para ver horas exactas</div>
    </div>

    <p class="seg-note"><strong>Cómo se mide:</strong> activo = página visible y con movimiento de mouse, teclado, clics o scroll en los últimos 2 minutos ·
      inactivo = visible pero sin tocar nada · otra pestaña = abierta pero minimizada o detrás de otra ventana · vacío = página cerrada o PC apagada.
      Si alguien tiene 2 pestañas abiertas cuenta el mejor estado, sin duplicar tiempo. Se guarda 90 días.</p>`;
    document.querySelector('.content').appendChild(v);
  }
  if (currentPage === 'seguimiento') v.classList.add('active');
  return v;
}

function segInjectStyle() {
  if (document.getElementById('seg-style')) return;
  const s = document.createElement('style');
  s.id = 'seg-style';
  s.textContent = `
.seg-lab-tag { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 99px; background: rgba(245,158,11,.16); color: #fbbf24; }
.seg-datenav { display: flex; align-items: center; gap: 6px; }
.seg-datenav input[type=date] { background: var(--main-bg); border: 1px solid var(--border); color: var(--text-dark); border-radius: var(--radius-sm);
  padding: 5px 8px; font-family: inherit; font-size: 12.5px; color-scheme: dark; }
.seg-legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11.5px; color: var(--text-mid); }
.seg-legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; margin-right: 5px; vertical-align: -2px; }
.seg-legend-sm { margin: 8px 0 4px; }
.seg-activo { background: #22c55e; }
.seg-inactivo { background: #d99a3d; }
.seg-oculto { background: #5b616b; }
.seg-off { background: var(--main-bg); border: 1px solid var(--border); }
.seg-board { overflow-x: auto; }
.seg-row { display: grid; grid-template-columns: 250px minmax(420px, 1fr) 230px; align-items: center; gap: 16px;
  padding: 10px 18px; border-bottom: 1px solid var(--border); min-width: 940px; cursor: pointer; transition: background .12s; }
.seg-row:hover, .seg-row:focus-visible { background: var(--card-bg-2); outline: none; }
.seg-row-head { cursor: default; padding-top: 8px; padding-bottom: 6px; background: var(--card-bg); }
.seg-row-head:hover { background: var(--card-bg); }
.seg-h { font-size: 10.5px; font-weight: 700; letter-spacing: .8px; text-transform: uppercase; color: var(--text-light); }
.seg-who { display: flex; align-items: center; gap: 10px; min-width: 0; }
.seg-id { min-width: 0; }
.seg-name { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.seg-sub { display: flex; align-items: center; gap: 7px; margin-top: 3px; font-size: 11px; color: var(--text-light); flex-wrap: wrap; }
.seg-sub .acct-code { font-size: 10.5px; padding: 1px 6px; }
.seg-scale { position: relative; height: 14px; font-size: 10px; color: var(--text-light); }
.seg-scale span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.seg-scale span:first-child { transform: none; }
.seg-scale span:last-child { transform: translateX(-100%); }
.seg-track { position: relative; height: 22px; border-radius: 6px; overflow: hidden; border: 1px solid var(--border); background-color: var(--main-bg);
  background-image: linear-gradient(to right, rgba(255,255,255,.07) 1px, transparent 1px); background-size: calc(100% / var(--hours)) 100%; }
.seg-track-lg { height: 38px; margin-top: 4px; }
.seg-run { position: absolute; top: 0; bottom: 0; min-width: 2px; }
.seg-now { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--nav-accent); box-shadow: 0 0 0 1px rgba(0,0,0,.45); }
.seg-stats { display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; color: var(--text-mid); }
.seg-stats strong { color: #4ade80; font-size: 13.5px; }
.seg-times { color: var(--text-light); }
.seg-off-txt { color: var(--text-light); font-style: italic; }
.seg-online { font-size: 10px; font-weight: 700; padding: 1px 7px; border-radius: 99px; white-space: nowrap; }
.seg-online--activo { background: var(--green-soft); color: #4ade80; }
.seg-online--inactivo { background: var(--amber-soft); color: #fbbf24; }
.seg-online--oculto { background: rgba(156,168,181,.16); color: #b4bec9; }
.seg-empty { padding: 34px 20px; text-align: center; color: var(--text-light); font-size: 13px; }
.seg-empty-sm { padding: 10px 0; color: var(--text-light); font-size: 12px; }
.seg-note { font-size: 11.5px; color: var(--text-light); line-height: 1.55; margin: 0 4px 22px; }
.seg-kpi { cursor: default; }
.seg-kpi:hover { transform: none; }
.seg-kpi .dash-kpi-value { font-size: 26px; }
.ui-modal--wide:has(.seg-detail) { width: min(980px, 100%); }
.ui-modal--wide:has(.seg-detail) .ui-modal-body { max-height: min(72vh, 760px); }
.seg-dhead { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
.seg-dday { margin-left: auto; font-size: 12px; color: var(--text-mid); text-align: right; }
.seg-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 6px; }
.seg-tile { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--main-bg); border: 1px solid var(--border); }
.seg-tile span { font-size: 11px; color: var(--text-light); }
.seg-tile b { font-size: 16px; color: var(--text-dark); }
.seg-tile small { font-size: 10.5px; color: var(--text-light); }
.seg-dsec { margin: 16px 0 8px; font-size: 10.5px; font-weight: 700; letter-spacing: .8px; text-transform: uppercase; color: var(--text-mid); }
.seg-dsec small { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--text-light); }
.seg-dcols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 22px; }
.seg-bar-row { display: grid; grid-template-columns: 140px minmax(0, 1fr) 110px; align-items: center; gap: 10px; font-size: 12px; color: var(--text-mid); padding: 3px 0; }
.seg-bar-row > span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.seg-bar-track { display: flex; height: 10px; border-radius: 99px; overflow: hidden; background: var(--main-bg); border: 1px solid var(--border); }
.seg-bar-track i { display: block; height: 100%; background: var(--blue); }
.seg-week-track { height: 14px; }
.seg-bar-track i.seg-activo { background: #22c55e; }
.seg-bar-track i.seg-inactivo { background: #d99a3d; }
.seg-bar-track i.seg-oculto { background: #5b616b; }
.seg-bar-val { text-align: right; white-space: nowrap; }
.seg-bar-val strong { color: #4ade80; }
.seg-hours { display: flex; align-items: flex-end; gap: 3px; height: 96px; }
.seg-hour { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; gap: 3px; font-size: 9.5px; color: var(--text-light); }
.seg-hour i { display: block; width: 100%; min-height: 1px; border-radius: 3px 3px 0 0; background: var(--blue); opacity: .85; }
@media (max-width: 720px) { .seg-dcols { grid-template-columns: minmax(0, 1fr); } .seg-bar-row { grid-template-columns: 100px minmax(0, 1fr) 90px; } }
`;
  document.head.appendChild(s);
}
