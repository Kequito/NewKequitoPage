/* Vista REGISTRO — registro de actividad (supabase/14_registro_actividad.sql).
   Supabase anota cada acción importante (cargas, Recalls, cuentas, permisos, configuración y sesiones);
   aquí solo se lee con act_get(desde, hasta) y se filtra en el navegador.
   Permiso view.registro (Supervisor). Como es "view.…", el Admin puede moverla a su Laboratorio. */

let regLoaded = false;
let regBusy = false;
let regReq = 0;
let regRows = [];            // [{ id, at, nombre, codigo, cargo, tipo, accion, resumen, detalle }]
let regRange = '7d';         // hoy | ayer | 7d | mes | mesant
let regTipo = '';            // '' = todos
let regShowSessions = false; // inicios / cierres de sesión (las claves incorrectas se ven siempre)
let regLimit = 100;
let regOpen = new Set();     // ids con el detalle abierto

const REG_TIPOS = [
  { key: 'carga',    label: 'Cargas',        icon: '⬆', color: '#4c8dff' },
  { key: 'recalls',  label: 'Recalls',       icon: '🔁', color: '#f87171' },
  { key: 'cuentas',  label: 'Cuentas',       icon: '👤', color: '#c084fc' },
  { key: 'permisos', label: 'Permisos',      icon: '🔐', color: '#fbbf24' },
  { key: 'config',   label: 'Configuración', icon: '⚙', color: '#9ca8b5' },
  { key: 'sesion',   label: 'Sesiones',      icon: '🔑', color: '#22c55e' },
];
const REG_RANGES = [
  { key: 'hoy', label: 'Hoy' }, { key: 'ayer', label: 'Ayer' }, { key: '7d', label: 'Últimos 7 días' },
  { key: 'mes', label: 'Mes actual' }, { key: 'mesant', label: 'Mes anterior' },
];
const REG_SESSION_NOISE = ['sesion.entrar', 'sesion.salir'];

function regTipoInfo(key) { return REG_TIPOS.find(t => t.key === key) || { key, label: key, icon: '•', color: 'var(--text-light)' }; }

/* { desde, hasta } del periodo elegido (hora local) */
function regBounds(range) {
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const day = n => { const d = new Date(d0); d.setDate(d.getDate() + n); return d; };
  if (range === 'hoy') return { desde: d0, hasta: day(1) };
  if (range === 'ayer') return { desde: day(-1), hasta: d0 };
  if (range === 'mes') return { desde: new Date(d0.getFullYear(), d0.getMonth(), 1), hasta: day(1) };
  if (range === 'mesant') return { desde: new Date(d0.getFullYear(), d0.getMonth() - 1, 1), hasta: new Date(d0.getFullYear(), d0.getMonth(), 1) };
  return { desde: day(-6), hasta: day(1) };
}

async function regInitView() {
  regLoaded = true;
  regRenderToolbar();
  await regLoad();
}

async function regLoad(silent = false) {
  if (silent && regBusy) return;
  regBusy = true;
  const req = ++regReq;   // si se cambia de periodo mientras carga, solo vale la última consulta
  const list = document.getElementById('reg-list');
  const err = document.getElementById('reg-error');
  if (!silent) { list.innerHTML = uiSkeleton(6); err.hidden = true; }
  try {
    const { desde, hasta } = regBounds(regRange);
    const rows = await sbRpc('act_get', { p_desde: desde.toISOString(), p_hasta: hasta.toISOString() });
    if (req !== regReq) return;
    regRows = Array.isArray(rows) ? rows : [];
    err.hidden = true;
    regPopulatePeople();
    regRender();
    document.getElementById('reg-updated').textContent = `Actualizado ${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (e) {
    console.error('Error cargando el registro:', e);
    if (silent || req !== regReq) return;
    const missing = /act_get|function|404/i.test(e.message || '');
    err.innerHTML = `${escapeHtml(missing ? 'Falta correr en Supabase el script 14 (registro de actividad).' : (e.message || 'No se pudo cargar el registro.'))} ${uiRetryButton('regLoad()')}`;
    err.hidden = false;
    list.innerHTML = '';
  } finally {
    regBusy = false;
  }
}

function regRenderToolbar() {
  document.getElementById('reg-ranges').innerHTML = REG_RANGES.map(r =>
    `<button type="button" class="eq-seg-btn ${regRange === r.key ? 'active' : ''}" onclick="regSetRange('${r.key}')">${r.label}</button>`).join('');
  document.getElementById('reg-tipos').innerHTML = [{ key: '', label: 'Todo', icon: '', color: 'var(--nav-accent)' }, ...REG_TIPOS].map(t =>
    `<button type="button" class="dash-tab ${regTipo === t.key ? 'on' : ''}" style="--c:${t.color}" onclick="regSetTipo('${t.key}')">${t.icon ? `${t.icon} ` : ''}${t.label}</button>`).join('');
  document.getElementById('reg-sessions').checked = regShowSessions;
}

function regSetRange(key) { regRange = key; regLimit = 100; regOpen.clear(); regRenderToolbar(); regLoad(); }
function regSetTipo(key) { regTipo = key; regLimit = 100; regRenderToolbar(); regRender(); }
function regToggleSessions(on) { regShowSessions = on; regLimit = 100; regRender(); }
function regShowMore() { regLimit += 100; regRender(); }
function regToggleRow(id) { regOpen.has(id) ? regOpen.delete(id) : regOpen.add(id); regRender(); }

/* Selector de persona: "NOMBRE · GC-0003" (el código es la identidad: no cambia aunque cambie el nombre) */
function regPopulatePeople() {
  const sel = document.getElementById('reg-person');
  const prev = sel.value;
  const people = new Map();
  regRows.forEach(r => { const k = r.codigo || r.nombre; if (!people.has(k)) people.set(k, r); });
  const opts = [...people.entries()].sort((a, b) => a[1].nombre.localeCompare(b[1].nombre));
  sel.innerHTML = '<option value="">Todas las personas</option>' + opts.map(([k, r]) =>
    `<option value="${escapeHtml(k)}">${escapeHtml(r.nombre)}${r.codigo ? ` · ${escapeHtml(r.codigo)}` : ''}</option>`).join('');
  if (prev && people.has(prev)) sel.value = prev;
}

function regFiltered() {
  const person = document.getElementById('reg-person').value;
  const q = document.getElementById('reg-search').value.trim().toLowerCase();
  return regRows.filter(r => {
    if (!regShowSessions && REG_SESSION_NOISE.includes(r.accion)) return false;
    if (regTipo && r.tipo !== regTipo) return false;
    if (person && (r.codigo || r.nombre) !== person) return false;
    if (q && !`${r.resumen} ${r.nombre} ${r.codigo || ''}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

function regRender() {
  const rows = regFiltered();
  regRenderKPIs(rows);
  const list = document.getElementById('reg-list');
  document.getElementById('reg-count').textContent = `${rows.length} registro${rows.length === 1 ? '' : 's'}`;
  if (!rows.length) {
    list.innerHTML = `<div class="gd-state pad-30"><p>No hay actividad para mostrar</p><small>Prueba con otro periodo o quita los filtros.</small></div>`;
    return;
  }
  const shown = rows.slice(0, regLimit);
  let html = '', lastDay = '';
  shown.forEach(r => {
    const d = new Date(r.at);
    const dayKey = d.toDateString();
    if (dayKey !== lastDay) {
      lastDay = dayKey;
      const label = d.toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' });
      html += `<div class="reg-day">${escapeHtml(label.charAt(0).toUpperCase() + label.slice(1))}</div>`;
    }
    html += regRowHTML(r);
  });
  if (rows.length > shown.length) html += `<button type="button" class="btn btn-ghost btn-sm reg-more" onclick="regShowMore()">Ver ${Math.min(100, rows.length - shown.length)} más (${rows.length - shown.length} restantes)</button>`;
  list.innerHTML = html;
}

function regRenderKPIs(rows) {
  const people = new Set(rows.map(r => r.codigo || r.nombre)).size;
  const cargas = rows.filter(r => r.tipo === 'carga').length;
  const malas = regRows.filter(r => r.accion === 'sesion.clave_incorrecta').length;
  const kpi = (label, value, sub, cls = '') => `<div class="kpi-card"><div class="kpi-header"><span class="kpi-label">${label}</span></div><div class="kpi-value ${cls}">${value}</div><span class="kpi-sub">${sub}</span></div>`;
  document.getElementById('reg-kpis').innerHTML = [
    kpi('Acciones', rows.length.toLocaleString('es-PE'), 'con los filtros elegidos'),
    kpi('Personas', people, 'hicieron algo en el periodo'),
    kpi('Cargas de data', cargas, 'Excel subidos o data pegada'),
    kpi('Claves incorrectas', malas, malas ? 'intentos fallidos de entrar' : 'ningún intento fallido', malas ? 'ol-kpi-red' : ''),
  ].join('');
}

function regRowHTML(r) {
  const t = regTipoInfo(r.tipo);
  const d = new Date(r.at);
  const open = regOpen.has(r.id);
  const detail = regDetailHTML(r);
  const bad = r.accion === 'sesion.clave_incorrecta';
  return `<div class="reg-row ${bad ? 'reg-row--bad' : ''} ${open ? 'open' : ''}" style="--c:${t.color}">
    <div class="reg-time">${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div>
    <div class="reg-main">
      <div class="reg-who">${eqAvatar(r.nombre)}<span class="reg-name">${escapeHtml(r.nombre)}</span>${r.codigo ? `<span class="reg-code">${escapeHtml(r.codigo)}</span>` : ''}${r.cargo ? `<span class="reg-cargo">${escapeHtml(r.cargo)}</span>` : ''}</div>
      <div class="reg-what"><span class="reg-tipo">${t.icon} ${escapeHtml(t.label)}</span> ${escapeHtml(regResumen(r))}</div>
      ${open && detail ? `<div class="reg-detail">${detail}</div>` : ''}
    </div>
    ${detail ? `<button type="button" class="btn btn-ghost btn-sm reg-toggle" onclick="regToggleRow(${Number(r.id)})" aria-expanded="${open}">${open ? 'Ocultar' : 'Detalle'}</button>` : ''}
  </div>`;
}

/* Nombre legible de un link de Data (dt_data_links.section_key) */
const REG_LINK_LABELS = { recalls: 'Gestión de Recalls', opstoday: 'Stats OPs Today', leads: 'Leads por Campaña / Operational Coverage',
  rep_approve: 'Reporte · Leads & Approve', rep_check: 'Reporte · Check', rep_wait: 'Reporte · T.Wait',
  ext_ordenes: 'Inicio · Extensión de órdenes (Drive)' };
function regLinkLabel(key) {
  const s = (typeof DATA_SECTIONS !== 'undefined') && DATA_SECTIONS.find(x => x.key === key);
  return (s && s.label) || REG_LINK_LABELS[key] || key;
}

function regResumen(r) {
  if (r.accion === 'config.link' && r.detalle && r.detalle.clave) return `Cambió el link de Data de «${regLinkLabel(r.detalle.clave)}»`;
  return r.resumen;
}

function regDetailHTML(r) {
  const x = r.detalle || {};
  const line = (k, v) => `<div><span class="reg-dk">${k}</span> ${v}</div>`;
  const perms = list => (list || []).map(p => `<span class="reg-perm">${escapeHtml(permLabel(p))}</span>`).join(' ') || '<span class="eq-muted">—</span>';
  const out = [];
  if (r.accion === 'permisos.cargo') {
    out.push(line('Agregó:', perms(x.agrego)), line('Quitó:', perms(x.quito)));
  } else if (r.accion === 'permisos.cuenta') {
    const fmt = o => Object.entries(o || {}).map(([p, v]) => `<span class="reg-perm ${v ? '' : 'is-off'}">${v ? '+' : '−'} ${escapeHtml(permLabel(p))}</span>`).join(' ') || '<span class="eq-muted">todo según su cargo</span>';
    out.push(line('Antes:', fmt(x.antes)), line('Ahora:', fmt(x.despues)));
  } else if (r.accion === 'cuenta.editar' && x.cambios) {
    Object.entries(x.cambios).forEach(([k, [a, b]]) => out.push(line(`${escapeHtml(k)}:`, `${escapeHtml(a || '—')} → <strong>${escapeHtml(b || '—')}</strong>`)));
  } else if (r.accion === 'config.link' && x.url) {
    out.push(line('Link nuevo:', `<a href="${escapeHtml(safeUrl(x.url))}" target="_blank" rel="noopener" class="reg-link">${escapeHtml(x.url)}</a>`));
  } else if (r.accion === 'recalls.revisar' && Array.isArray(x.ids) && x.ids.length) {
    out.push(line('Órdenes:', x.ids.map(id => `<span class="reg-perm">#${escapeHtml(id)}</span>`).join(' ') + (x.cantidad > x.ids.length ? ` <span class="eq-muted">y ${x.cantidad - x.ids.length} más</span>` : '')));
  } else if (r.accion === 'recalls.comparar' && x.colores) {
    out.push(line('Colores:', Object.entries(x.colores).map(([c, n]) => `<span class="reg-perm">${escapeHtml(c)}: ${n}</span>`).join(' ')));
  } else if (r.accion === 'carga.recalls' && x.archivo) {
    out.push(line('Archivo:', escapeHtml(x.archivo)));
  }
  return out.join('');
}
