/* Vista Gestión de Cuentas — cuentas, contraseñas y PERMISOS (por cargo y por cuenta).
   Requiere el permiso "accounts.manage".

   Organización:
   · Indicadores arriba (clic = filtrar) y un aviso de pendientes (claves temporales sin cambiar,
     cuentas sin contraseña).
   · Apartado "Cuentas": lista agrupada por cargo, con búsqueda y filtros; clic en una fila = ficha completa
     (datos, código, contraseña, permisos efectivos y todas las acciones).
   · Apartado "Permisos por cargo": la tabla de casillas de siempre.
   Crear y editar cuentas se hace en un diálogo (ya no en un formulario fijo en la página). */

/* ══════════════════════════════
   GESTIÓN DE CUENTAS
   El "portón" pide la contraseña de quien entra en cada visita (hace un app_login nuevo).
   La protección real está en Supabase: crear/editar/eliminar cuentas, cambiar contraseñas y
   editar permisos pasa por funciones (acct_*, set_user_password, perm_*) que exigen el permiso
   "accounts.manage" — ver supabase/03_permisos.sql y 08_claves_y_codigos.sql.
══════════════════════════════ */
let acctLoaded = false;
let acctList = [];            // [{nombre, perop1am, cargo, genero, tieneClave}]

let permRoles = {};           // guardado:  { 'supervisor': Set, 'team leader': Set, 'operador': Set }
let permRoleDraft = {};       // en edición (lo que muestran las casillas)
let permAccounts = new Map(); // nombre → { extra: {perm: bool}, hasPass, effective: Set }
let permAvailable = true;     // false si Supabase todavía no tiene 03_permisos.sql
let acctStatus = new Map();   // nombre → { codigo, tiene_clave, clave_temporal, clave_cambiada_at } (script 08)

let acctTab = 'cuentas';      // 'cuentas' | 'permisos'
let acctFilterCargo = '';     // '' | 'Supervisor' | 'Team Leader' | 'Operador'
let acctFilterPass = '';      // '' | 'propia' | 'temporal' | 'sin' | 'custom'

const ACCT_CARGOS = ['Supervisor', 'Team Leader', 'Operador'];
const ACCT_CARGO_PLURAL = { 'Supervisor': 'Supervisores', 'Team Leader': 'Team Leaders', 'Operador': 'Operadores' };
const ACCT_CARGO_COLORS = {
  'Operador':    { bg: 'rgba(156,168,181,.16)', color: '#b4bec9' },
  'Team Leader': { bg: 'var(--blue-soft)',      color: 'var(--blue)' },
  'Supervisor':  { bg: 'var(--green-soft)',     color: 'var(--green)' },
};
/* Devuelve "status — mensaje real de Postgres/PostgREST" en vez de un status pelado,
   para no tener que adivinar la causa (RLS, constraint, etc.) cuando algo falla. */
async function acctErrorDetail(res) {
  const text = await res.text().catch(() => '');
  let msg = text;
  try { msg = JSON.parse(text).message || text; } catch { /* no era JSON */ }
  return `${res.status}${msg ? ` — ${msg}` : ''}`;
}

function acctCargoBadge(cargo) {
  const c = ACCT_CARGO_COLORS[cargo] || { bg: 'var(--main-bg)', color: 'var(--text-mid)' };
  return `<span class="pill-badge" style="--bg:${c.bg};--fg:${c.color}">${escapeHtml(cargo) || '—'}</span>`;
}

/* ══════════════════════════════
   PERMISOS — carga, editor por cargo (tabla de casillas) y excepciones por cuenta
══════════════════════════════ */
async function permLoadAll() {
  try {
    const data = await sbRpc('perm_get_all');
    permAvailable = true;
    permRoles = {};
    PERM_ROLES.forEach(r => { permRoles[r.key] = new Set(); });
    (data.roles || []).forEach(r => { permRoles[r.role] = new Set(r.perms || []); });
    permAccounts = new Map((data.accounts || []).map(a => [a.nombre, {
      extra: a.extra || {}, hasPass: !!a.has_pass, effective: new Set(a.effective || []),
    }]));
  } catch (err) {
    console.error('Permisos no disponibles:', err);
    permAvailable = false;
    permRoles = {};
    PERM_ROLES.forEach(r => { permRoles[r.key] = new Set(PERM_FALLBACK[r.key] || []); });
    permAccounts = new Map();
  }
  permRoleDraft = {};
  Object.keys(permRoles).forEach(k => { permRoleDraft[k] = new Set(permRoles[k]); });
}

function permRoleDirtyRoles() {
  return PERM_ROLES.map(r => r.key).filter(k => {
    const a = permRoles[k] || new Set(), b = permRoleDraft[k] || new Set();
    return a.size !== b.size || [...a].some(p => !b.has(p));
  });
}

/* Encabezado de la tabla: cada cargo con cuántos permisos tiene marcados */
function renderPermRoleHead() {
  const total = PERM_CATALOG.length;
  document.getElementById('perm-role-head').innerHTML = '<th>Permiso</th>' + PERM_ROLES.map(r => {
    const n = (permRoleDraft[r.key] || new Set()).size;
    return `<th class="text-center">${acctCargoBadge(r.label)}<div class="perm-count">${n} de ${total}</div></th>`;
  }).join('');
}

function renderPermRoleMatrix() {
  const warn = document.getElementById('perm-role-warn');
  warn.hidden = permAvailable;
  if (!permAvailable) warn.textContent = 'Supabase todavía no tiene la configuración de permisos (supabase/03_permisos.sql). Se muestran los valores por defecto y no se pueden guardar cambios.';

  renderPermRoleHead();
  const tbody = document.getElementById('perm-role-tbody');
  tbody.innerHTML = PERM_GROUPS.map(g => {
    const rows = PERM_CATALOG.filter(p => p.group === g.id).map(p => `<tr>
      <td>${escapeHtml(p.label)}${p.sensitive ? ' <span class="perm-lock" title="Sensible: solo funciona en cuentas con contraseña">🔒</span>' : ''}</td>
      ${PERM_ROLES.map(r => {
        const on = !!permRoleDraft[r.key]?.has(p.key);
        const dirty = on !== !!permRoles[r.key]?.has(p.key);
        return `<td class="text-center ${dirty ? 'perm-cell--dirty' : ''}">
        <input type="checkbox" class="perm-check" ${on ? 'checked' : ''} ${permAvailable ? '' : 'disabled'}
          aria-label="${escapeHtml(`${r.label}: ${p.label}`)}" onchange="permRoleToggle(${jsArg(r.key)}, ${jsArg(p.key)}, this)"/>
      </td>`;
      }).join('')}
    </tr>`).join('');
    return `<tr class="perm-group-row"><td colspan="${PERM_ROLES.length + 1}">${escapeHtml(g.label)}</td></tr>${rows}`;
  }).join('');
  permRoleUpdateButtons();
}

function permRoleToggle(role, perm, input) {
  const set = permRoleDraft[role] || (permRoleDraft[role] = new Set());
  input.checked ? set.add(perm) : set.delete(perm);
  input.closest('td').classList.toggle('perm-cell--dirty', input.checked !== !!permRoles[role]?.has(perm));
  renderPermRoleHead();
  permRoleUpdateButtons();
}

function permRoleUpdateButtons() {
  const dirty = permRoleDirtyRoles();
  document.getElementById('perm-role-save').disabled = !permAvailable || dirty.length === 0;
  document.getElementById('perm-role-discard').disabled = dirty.length === 0;
  const status = document.getElementById('perm-role-status');
  status.className = 'perm-status' + (dirty.length ? ' perm-status--dirty' : '');
  status.textContent = dirty.length
    ? `Cambios sin guardar: ${dirty.map(k => PERM_ROLES.find(r => r.key === k).label).join(', ')}`
    : '';
  // Aviso en la pestaña para que no se olviden cambios sin guardar al pasar a "Cuentas"
  const tab = document.querySelector('.acct-tab-btn[data-tab="permisos"]');
  if (tab) tab.textContent = dirty.length ? '🛡 Permisos por cargo •' : '🛡 Permisos por cargo';
}

function permRoleDiscard() {
  Object.keys(permRoles).forEach(k => { permRoleDraft[k] = new Set(permRoles[k]); });
  renderPermRoleMatrix();
}

async function permRoleSave() {
  const dirty = permRoleDirtyRoles();
  if (!dirty.length) return;
  const lost = dirty.filter(k => permRoles[k]?.has('accounts.manage') && !permRoleDraft[k]?.has('accounts.manage'));
  if (lost.length) {
    const ok = await uiConfirm(`Vas a quitarle "Gestión de Cuentas y permisos" a: ${lost.map(k => PERM_ROLES.find(r => r.key === k).label).join(', ')}.\nQuienes tengan ese cargo ya no podrán entrar a esta sección.`,
      { title: '¿Quitar un permiso importante?', confirmText: 'Guardar igual', danger: true });
    if (!ok) return;
  }
  const btn = document.getElementById('perm-role-save');
  btn.disabled = true;
  try {
    for (const role of dirty) {
      await sbRpc('perm_set_role', { p_role: role, p_perms: [...permRoleDraft[role]] });
    }
    await permAfterChange();
    const status = document.getElementById('perm-role-status');
    status.className = 'perm-status perm-status--ok';
    status.textContent = '✓ Permisos guardados — ya aplican para todos';
    setTimeout(() => { if (!permRoleDirtyRoles().length) status.textContent = ''; }, 5000);
  } catch (err) {
    console.error('Error guardando permisos de cargo:', err);
    // Lo guardado a medias se refleja al recargar (cada cargo se guarda por separado)
    await permAfterChange();
    uiAlert(err.message || 'No se pudieron guardar los permisos.', { title: 'No se guardó', tone: 'danger' });
  }
}

/* Tras cualquier cambio de permisos: recargar todo y aplicar al instante MIS permisos (menú, botones) */
async function permAfterChange() {
  await permLoadAll();
  renderPermRoleMatrix();
  renderAcctAll();
  await permLoad();
  renderSidebar();
  if (!canSeePage(currentPage)) { const first = firstAllowedPage(); if (first) goToPage(first); }
}

/* Editor de excepciones de UNA cuenta: por cada permiso, "Según cargo" / "Permitir" / "Bloquear" */
async function acctEditPerms(nombre) {
  if (!permAvailable) {
    uiAlert('Supabase todavía no tiene la configuración de permisos (supabase/03_permisos.sql).', { title: 'No disponible', tone: 'warning' });
    return;
  }
  const u = acctList.find(a => a.nombre === nombre);
  const info = permAccounts.get(nombre) || { extra: {}, hasPass: false };
  const roleKey = (u?.cargo || '').trim().toLowerCase();
  const roleSet = permRoles[roleKey] || new Set();
  const roleLabel = (PERM_ROLES.find(r => r.key === roleKey) || {}).label || u?.cargo || 'sin cargo';

  const body = uiEl('div', 'perm-acct');
  if (!info.hasPass) {
    body.appendChild(uiEl('div', 'perm-acct-warn', '⚠ Esta cuenta no tiene contraseña: los permisos 🔒 no se le aplicarán aunque los permitas.'));
  }
  const selects = [];
  PERM_GROUPS.forEach(g => {
    body.appendChild(uiEl('div', 'perm-acct-group', g.label));
    PERM_CATALOG.filter(p => p.group === g.id).forEach(p => {
      const row = uiEl('label', 'perm-acct-row');
      row.appendChild(uiEl('span', 'perm-acct-label', p.label + (p.sensitive ? ' 🔒' : '')));
      const sel = uiEl('select', 'form-select-sm');
      const fromRole = roleSet.has(p.key);
      [['', `Según cargo (${fromRole ? '✓ sí' : '✗ no'})`], ['allow', 'Permitir'], ['deny', 'Bloquear']].forEach(([v, t]) => {
        const o = uiEl('option', null, t); o.value = v; sel.appendChild(o);
      });
      const cur = info.extra ? info.extra[p.key] : undefined;
      sel.value = cur === true ? 'allow' : cur === false ? 'deny' : '';
      sel.dataset.perm = p.key;
      const syncCls = () => row.classList.toggle('perm-acct-row--custom', sel.value !== '');
      sel.addEventListener('change', syncCls); syncCls();
      selects.push(sel);
      row.appendChild(sel);
      body.appendChild(row);
    });
  });

  const saved = await uiDialog({
    title: `Permisos de ${nombre}`,
    message: `Cargo: ${roleLabel}. Solo cambia lo que quieras distinto al cargo; lo demás queda "Según cargo".`,
    body, wide: true, confirmText: 'Guardar permisos',
    extraButton: { text: 'Todo según cargo', onClick: () => selects.forEach(s => { s.value = ''; s.dispatchEvent(new Event('change')); }) },
    onConfirm: async () => {
      const extra = {};
      selects.forEach(s => { if (s.value) extra[s.dataset.perm] = s.value === 'allow'; });
      try {
        await sbRpc('perm_set_account', { p_nombre: nombre, p_extra: extra });
        return null;
      } catch (err) {
        return err.message || 'No se pudieron guardar los permisos.';
      }
    },
  });
  if (saved) await permAfterChange();
}

/* ══════════════════════════════
   ENTRADA (portón) Y CARGA
══════════════════════════════ */
function loadAccountsView() {
  acctLoaded = true;
  if (!can('accounts.manage')) return;   // setNav ya lo impide; doble seguro
  document.getElementById('acct-gate').style.display = 'flex';
  document.getElementById('acct-content').style.display = 'none';
  document.getElementById('acct-gate-pass').value = '';
  document.getElementById('acct-gate-error').textContent = '';
  setTimeout(() => { const el = document.getElementById('acct-gate-pass'); if (el) el.focus(); }, 100);
}

async function acctUnlock() {
  const me = getCurrentUser();
  const pass = document.getElementById('acct-gate-pass').value;
  const err = document.getElementById('acct-gate-error');
  err.textContent = '';
  if (!me || !pass) { err.textContent = 'Ingresa tu contraseña.'; return; }

  try {
    // Reconfirmar = volver a hacer login: la sesión vieja se cierra y queda la nueva (token fresco)
    const ok = await sessionRenew(async () => {
      const rows = await sbRpc('app_login', { p_nombre: me[0], p_password: pass });
      if (!rows || rows.length === 0) return false;
      try { await sbRpc('app_logout'); } catch (e) { /* la vieja vence sola */ }
      saveSessionToken(rows[0].token, rows[0].expires_at);
      return true;
    });
    if (!ok) { err.textContent = 'Contraseña incorrecta.'; return; }
    document.getElementById('acct-gate').style.display = 'none';
    document.getElementById('acct-content').style.display = 'block';
    acctSetTab(acctTab);
    await acctLoadList();
  } catch (e) {
    err.textContent = loginErrorText(e);
  }
}

async function acctLoadList() {
  if (!acctList.length) document.getElementById('acct-tbody').innerHTML = '<tr><td colspan="5" class="td-empty">Cargando cuentas…</td></tr>';
  try {
    const [data, status] = await Promise.all([
      sbFetch('dt_session_public', 'select=NOMBRE,PEROP1AM,CARGO,GENERO,TIENE_CLAVE&order=NOMBRE.asc'),
      // Código y estado de la clave: si falta el script 08, la lista sigue funcionando sin esas columnas
      sbRpc('acct_status_list').catch(err => { console.warn('Cuentas: falta el script 08 (claves y códigos)', err); return null; }),
      permLoadAll(),
    ]);
    acctStatus = new Map((status || []).map(s => [s.nombre, s]));
    acctList = data.map(r => ({
      nombre: r.NOMBRE || '', perop1am: r.PEROP1AM || '', cargo: r.CARGO || '', genero: r.GENERO || '',
      tieneClave: !!r.TIENE_CLAVE,
    }));
    renderAcctAll();
    renderPermRoleMatrix();
  } catch (err) {
    console.error('Error cargando cuentas:', err);
    document.getElementById('acct-tbody').innerHTML = `<tr><td colspan="5" class="td-empty td-error">No se pudieron cargar las cuentas: ${escapeHtml(err.message || 'intenta de nuevo')}</td></tr>`;
  }
}

/* Tras crear / editar / borrar: lista de la sección + lista del login (sin volver a arrancar la página) */
async function acctAfterChange() {
  await acctLoadList();
  await fetchSessionUsers();
}

/* ══════════════════════════════
   APARTADOS Y FILTROS
══════════════════════════════ */
function acctSetTab(tab) {
  acctTab = tab === 'permisos' ? 'permisos' : 'cuentas';
  document.getElementById('acct-tab-cuentas').hidden = acctTab !== 'cuentas';
  document.getElementById('acct-tab-permisos').hidden = acctTab !== 'permisos';
  document.querySelectorAll('.acct-tab-btn').forEach(b => {
    const on = b.dataset.tab === acctTab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
}

function acctSetCargoFilter(cargo) { acctFilterCargo = ACCT_CARGOS.includes(cargo) ? cargo : ''; renderAcctAll(); }
function acctSetPassFilter(v) { acctFilterPass = ['propia', 'temporal', 'sin', 'custom'].includes(v) ? v : ''; renderAcctAll(); }

/* Clic en un indicador: filtra por ese estado (otro clic en el mismo = quitar el filtro) */
function acctKpiFilter(v) {
  if (!v) { acctClearFilters(); return; }
  acctFilterPass = acctFilterPass === v ? '' : v;
  acctSetTab('cuentas');
  renderAcctAll();
}

function acctClearFilters() {
  acctFilterCargo = '';
  acctFilterPass = '';
  document.getElementById('acct-search').value = '';
  renderAcctAll();
}

/* ══════════════════════════════
   ESTADO DE CADA CUENTA
══════════════════════════════ */
function acctCode(u) { return (acctStatus.get(u.nombre) || {}).codigo || ''; }

/* 'propia' | 'temporal' | 'sin' */
function acctPassState(u) {
  const s = acctStatus.get(u.nombre);
  if (!s) return u.tieneClave ? 'propia' : 'sin';
  if (!s.tiene_clave) return 'sin';
  return s.clave_temporal ? 'temporal' : 'propia';
}

function acctCustomCount(u) {
  if (!permAvailable) return 0;
  const info = permAccounts.get(u.nombre);
  return info ? Object.keys(info.extra || {}).length : 0;
}

function acctIsMe(u) { const me = getCurrentUser(); return !!(me && me[0] === u.nombre); }

function acctFmtDateTime(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}

/* Celda "Contraseña". Nunca se muestra la contraseña: Supabase solo guarda su hash. */
function acctPassCell(u) {
  const s = acctStatus.get(u.nombre);
  const state = acctPassState(u);
  let html = state === 'sin'
    ? '<span class="badge acct-badge-none" title="Entra solo eligiendo su nombre">— Sin contraseña</span>'
    : state === 'temporal'
      ? '<span class="badge badge-amber" title="Clave temporal: al entrar con ella se le pide crear una propia">⏳ Temporal</span>'
      : '<span class="badge badge-green" title="La puso la misma persona">✓ Propia</span>';
  if (s && s.tiene_clave && s.clave_cambiada_at) {
    html += `<div class="acct-pass-when">${state === 'temporal' ? 'generada' : 'cambiada'} ${escapeHtml(repTimeAgo(s.clave_cambiada_at))}</div>`;
  }
  return html;
}

function acctPermCell(u) {
  if (!permAvailable) return '<span class="muted-11">—</span>';
  const n = acctCustomCount(u);
  return n
    ? `<span class="badge badge-blue" title="Tiene excepciones propias sobre los permisos de su cargo">🛡 Personalizado (${n})</span>`
    : '<span class="muted-11">Según cargo</span>';
}

/* ══════════════════════════════
   RENDER — indicadores, pendientes, filtros y lista
══════════════════════════════ */
function renderAcctAll() {
  renderAcctKPIs();
  renderAcctAttention();
  renderAcctTable();
}

function renderAcctKPIs() {
  const by = st => acctList.filter(u => acctPassState(u) === st).length;
  const perCargo = ACCT_CARGOS.map(c => `${acctList.filter(u => u.cargo === c).length} ${c === 'Team Leader' ? 'TL' : c === 'Supervisor' ? 'Sup.' : 'Op.'}`).join(' · ');
  const temp = by('temporal'), sin = by('sin'), propia = by('propia');
  const custom = acctList.filter(u => acctCustomCount(u) > 0).length;
  const cards = [
    { key: '', icon: '👥', label: 'Cuentas', value: acctList.length, sub: perCargo, tone: 'neutral' },
    { key: 'propia', icon: '✅', label: 'Contraseña propia', value: propia, sub: 'la puso cada persona', tone: 'good' },
    { key: 'temporal', icon: '⏳', label: 'Clave temporal', value: temp, sub: temp ? 'todavía no la cambian' : 'ninguna pendiente', tone: temp ? 'warn' : 'neutral' },
    { key: 'sin', icon: '🔓', label: 'Sin contraseña', value: sin, sub: sin ? 'entran solo con su nombre' : 'todas protegidas', tone: sin ? 'bad' : 'good' },
    { key: 'custom', icon: '🛡', label: 'Excepciones', value: custom, sub: 'permisos distintos a su cargo', tone: 'neutral' },
  ];
  const el = document.getElementById('acct-kpis');
  el.style.setProperty('--n', cards.length);
  el.innerHTML = cards.map(c => {
    const on = c.key ? acctFilterPass === c.key : (!acctFilterPass && !acctFilterCargo);
    return `<button type="button" class="dash-kpi dash-kpi--${c.tone} acct-kpi ${on ? 'is-on' : ''}" onclick="acctKpiFilter('${c.key}')"
        aria-pressed="${on}" title="${c.key ? 'Ver solo estas cuentas' : 'Ver todas las cuentas'}">
      <span class="dash-kpi-head"><span class="dash-kpi-icon">${c.icon}</span><span class="dash-kpi-label">${c.label}</span></span>
      <span class="dash-kpi-row"><span class="dash-kpi-value">${c.value}</span></span>
      <span class="dash-kpi-sub">${c.sub}</span>
    </button>`;
  }).join('');
}

/* Pendientes: lo que conviene resolver (claves temporales sin cambiar, TL/Operadores sin contraseña) */
function renderAcctAttention() {
  const box = document.getElementById('acct-attention');
  const temp = acctList.filter(u => acctPassState(u) === 'temporal')
    .map(u => ({ u, at: (acctStatus.get(u.nombre) || {}).clave_cambiada_at }))
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  const sin = acctList.filter(u => acctPassState(u) === 'sin');
  if (!temp.length && !sin.length) { box.hidden = true; box.innerHTML = ''; return; }
  const names = list => list.slice(0, 4).map(x => escapeHtml(x.nombre)).join(', ') + (list.length > 4 ? ` y ${list.length - 4} más` : '');
  const items = [];
  if (temp.length) {
    const oldest = temp[0].at ? ` — la más antigua ${repTimeAgo(temp[0].at)}` : '';
    items.push(`<div class="acct-att-item acct-att-item--warn"><span>⏳</span>
      <div><strong>${temp.length} ${temp.length === 1 ? 'cuenta todavía no cambia' : 'cuentas todavía no cambian'} su clave temporal</strong>${oldest}
      <small>${names(temp.map(x => x.u))}</small></div>
      <button type="button" class="btn btn-ghost btn-sm" onclick="acctKpiFilter('temporal')">Ver</button></div>`);
  }
  if (sin.length) {
    items.push(`<div class="acct-att-item acct-att-item--bad"><span>🔓</span>
      <div><strong>${sin.length} ${sin.length === 1 ? 'cuenta sin contraseña' : 'cuentas sin contraseña'}</strong> — cualquiera con el link puede entrar con su nombre
      <small>${names(sin)}</small></div>
      <button type="button" class="btn btn-ghost btn-sm" onclick="acctKpiFilter('sin')">Ver</button></div>`);
  }
  box.innerHTML = items.join('');
  box.hidden = false;
}

function acctFilteredList() {
  const q = (document.getElementById('acct-search').value || '').trim().toLowerCase();
  return acctList.filter(u =>
    (!acctFilterCargo || u.cargo === acctFilterCargo) &&
    (!acctFilterPass || (acctFilterPass === 'custom' ? acctCustomCount(u) > 0 : acctPassState(u) === acctFilterPass)) &&
    (!q || `${u.nombre} ${u.perop1am} ${acctCode(u)}`.toLowerCase().includes(q)));
}

function renderAcctCargoSeg() {
  const opts = [['', 'Todos', acctList.length], ...ACCT_CARGOS.map(c => [c, ACCT_CARGO_PLURAL[c], acctList.filter(u => u.cargo === c).length])];
  document.getElementById('acct-cargo-seg').innerHTML = opts.map(([v, label, n]) =>
    `<button type="button" class="eq-seg-btn ${acctFilterCargo === v ? 'active' : ''}" role="tab" aria-selected="${acctFilterCargo === v}"
      onclick="acctSetCargoFilter(${jsArg(v)})">${escapeHtml(label)} <span class="acct-seg-n">${n}</span></button>`).join('');
}

function acctRowHTML(u) {
  const nameArg = jsArg(u.nombre);
  const me = acctIsMe(u);
  const code = acctCode(u);
  return `<tr class="acct-row" tabindex="0" onclick="acctOpenCard(${nameArg})" onkeydown="if(event.key==='Enter')acctOpenCard(${nameArg})" title="Ver ficha de ${escapeHtml(u.nombre)}">
    <td><div class="acct-name-cell">${silhouetteHTML(u.genero, 'acct-avatar')}<div class="acct-id">
      <div class="acct-name">${escapeHtml(u.nombre)}${me ? ' <span class="tl-you">Tú</span>' : ''}</div>
      <div class="acct-sub">${code ? `<span class="acct-code">${escapeHtml(code)}</span>` : ''}<span>${escapeHtml(u.perop1am) || 'sin PEROP1AM'}</span></div>
    </div></div></td>
    <td>${acctCargoBadge(u.cargo)}</td>
    <td>${acctPassCell(u)}</td>
    <td>${acctPermCell(u)}</td>
    <td class="acct-actions" onclick="event.stopPropagation()" onkeydown="event.stopPropagation()">
      <button type="button" class="btn btn-ghost btn-sm acct-icon-btn" onclick="acctStartEdit(${nameArg})" title="Editar datos" aria-label="Editar datos de ${escapeHtml(u.nombre)}">✎</button>
      <button type="button" class="btn btn-ghost btn-sm acct-icon-btn" onclick="acctEditPerms(${nameArg})" title="Permisos de esta cuenta" aria-label="Permisos de ${escapeHtml(u.nombre)}">🛡</button>
      ${me
        ? '<button type="button" class="btn btn-ghost btn-sm acct-icon-btn" onclick="myAccountChangePassword()" title="Cambiar mi contraseña (sabiendo la actual)" aria-label="Cambiar mi contraseña">🔑</button>'
        : `<button type="button" class="btn btn-ghost btn-sm acct-icon-btn" onclick="acctResetPassword(${nameArg})" title="Generar clave temporal" aria-label="Generar clave temporal para ${escapeHtml(u.nombre)}">🔑</button>`}
      <button type="button" class="btn btn-ghost btn-sm acct-icon-btn acct-del" onclick="acctDeleteAccount(${nameArg})" ${me ? 'disabled title="No puedes eliminar tu propia cuenta"' : 'title="Eliminar cuenta"'} aria-label="Eliminar cuenta de ${escapeHtml(u.nombre)}">🗑</button>
    </td>
  </tr>`;
}

function renderAcctTable() {
  renderAcctCargoSeg();
  document.getElementById('acct-f-pass').value = acctFilterPass;
  const search = (document.getElementById('acct-search').value || '').trim();
  document.getElementById('acct-search').closest('.gd-search-wrap').classList.toggle('active', !!search);
  document.getElementById('acct-clear-btn').hidden = !(acctFilterCargo || acctFilterPass || search);

  const rows = acctFilteredList();
  document.getElementById('acct-count').textContent = rows.length === acctList.length
    ? `${acctList.length} cuenta${acctList.length === 1 ? '' : 's'}`
    : `${rows.length} de ${acctList.length} cuentas`;
  document.getElementById('acct-empty').hidden = rows.length > 0 || !acctList.length;

  // Agrupadas por cargo (Supervisor → Team Leader → Operador → otros), alfabético dentro de cada grupo
  const order = c => { const i = ACCT_CARGOS.indexOf(c); return i < 0 ? ACCT_CARGOS.length : i; };
  const sorted = [...rows].sort((a, b) => (order(a.cargo) - order(b.cargo)) || a.nombre.localeCompare(b.nombre));
  let html = '', lastCargo = null;
  sorted.forEach(u => {
    if (!acctFilterCargo && u.cargo !== lastCargo) {
      lastCargo = u.cargo;
      const n = sorted.filter(x => x.cargo === u.cargo).length;
      html += `<tr class="acct-group-row"><td colspan="5">${escapeHtml(ACCT_CARGO_PLURAL[u.cargo] || u.cargo || 'Sin cargo')} <span>${n}</span></td></tr>`;
    }
    html += acctRowHTML(u);
  });
  document.getElementById('acct-tbody').innerHTML = html;
}

/* ══════════════════════════════
   FICHA DE CUENTA — todo de una cuenta en un solo lugar
══════════════════════════════ */
async function acctOpenCard(nombre) {
  const u = acctList.find(a => a.nombre === nombre);
  if (!u) return;
  const me = acctIsMe(u);
  const s = acctStatus.get(u.nombre);
  const state = acctPassState(u);

  const body = uiEl('div', 'acct-card');
  const head = uiEl('div', 'acct-card-head');
  head.innerHTML = `${silhouetteHTML(u.genero, 'acct-card-avatar')}
    <div class="acct-card-id">
      <div class="acct-card-name">${escapeHtml(u.nombre)}${me ? ' <span class="tl-you">Tú</span>' : ''}</div>
      <div class="acct-card-badges">${acctCode(u) ? `<span class="acct-code">${escapeHtml(acctCode(u))}</span>` : ''}${acctCargoBadge(u.cargo)}</div>
    </div>`;
  body.appendChild(head);

  const passText = state === 'sin' ? 'Sin contraseña — entra solo eligiendo su nombre'
    : state === 'temporal' ? `Clave temporal pendiente de cambiar${s && s.clave_cambiada_at ? ` (generada el ${acctFmtDateTime(s.clave_cambiada_at)})` : ''}`
    : `Propia${s && s.clave_cambiada_at ? ` — cambiada el ${acctFmtDateTime(s.clave_cambiada_at)}` : ''}`;
  const info = uiEl('div', 'myacct-rows');
  [['Código', acctCode(u) || '—'], ['PEROP1AM', u.perop1am || '—'], ['Género', u.genero === 'F' ? 'Femenino' : u.genero === 'M' ? 'Masculino' : '—'], ['Contraseña', passText]]
    .forEach(([k, v]) => { const r = uiEl('div', 'myacct-row'); r.append(uiEl('span', 'myacct-k', k), uiEl('span', 'myacct-v', v)); info.appendChild(r); });
  body.appendChild(info);

  // Permisos efectivos: lo que de verdad puede ver y hacer (cargo + excepciones; sensibles solo con contraseña)
  if (permAvailable) {
    const p = permAccounts.get(u.nombre) || { extra: {}, effective: new Set() };
    const custom = Object.keys(p.extra || {}).length;
    body.appendChild(uiEl('div', 'acct-card-sec', custom ? `Permisos — ${custom} distinto${custom === 1 ? '' : 's'} a su cargo` : 'Permisos — según su cargo'));
    PERM_GROUPS.forEach(g => {
      const wrap = uiEl('div', 'acct-perm-chips');
      wrap.appendChild(uiEl('span', 'acct-perm-group', g.label));
      PERM_CATALOG.filter(x => x.group === g.id).forEach(x => {
        const on = p.effective.has(x.key);
        const isCustom = x.key in (p.extra || {});
        const chip = uiEl('span', `acct-perm-chip ${on ? 'is-on' : ''} ${isCustom ? 'is-custom' : ''}`,
          `${on ? '✓' : '✗'} ${x.label}${x.sensitive ? ' 🔒' : ''}`);
        if (isCustom) chip.title = p.extra[x.key] ? 'Permitido a mano para esta cuenta' : 'Bloqueado a mano para esta cuenta';
        else if (x.sensitive && !on && state === 'sin') chip.title = 'Sensible: necesita contraseña';
        wrap.appendChild(chip);
      });
      body.appendChild(wrap);
    });
  }

  // Acciones: cierran la ficha y abren su diálogo
  let next = null, closeCard = null;
  const actions = uiEl('div', 'acct-card-actions');
  const act = (text, cls, fn, disabled = false) => {
    const b = uiButton(text, `btn-ghost btn-sm ${cls}`, () => { next = fn; closeCard(false); });
    b.disabled = disabled;
    actions.appendChild(b);
  };
  act('✎ Editar datos', '', () => acctStartEdit(nombre));
  act('🛡 Permisos', '', () => acctEditPerms(nombre));
  if (me) act('🔑 Cambiar mi contraseña', '', () => myAccountChangePassword());
  else act('🔑 Clave temporal', '', () => acctResetPassword(nombre));
  act('🗑 Eliminar', 'acct-del', () => acctDeleteAccount(nombre), me);
  head.after(actions);   // justo debajo del nombre: siempre a la vista, sin bajar por los permisos

  await uiDialog({
    title: 'Ficha de cuenta', body, wide: true,
    confirmText: 'Cerrar', cancelText: null,
    bindClose: c => { closeCard = c; },
  });
  if (next) next();
}

/* ══════════════════════════════
   CLAVE TEMPORAL — la genera Supabase al azar, se muestra UNA sola vez
══════════════════════════════ */
async function acctResetPassword(nombre) {
  const u = acctList.find(a => a.nombre === nombre);
  if (!u) return;
  const canRemove = u.tieneClave && u.cargo !== 'Supervisor';   // un Supervisor no puede quedar sin contraseña

  const body = uiEl('div', 'acct-reset');
  body.appendChild(uiEl('p', 'acct-reset-text',
    'Se genera una clave al azar para pasársela por privado. Su contraseña actual deja de funcionar y se cierran sus sesiones abiertas. Al entrar con la clave temporal, se le pedirá crear una propia que solo esa persona sepa.'));
  let removeChk = null;
  if (canRemove) {
    const lbl = uiEl('label', 'check-label acct-reset-remove');
    removeChk = uiEl('input');
    removeChk.type = 'checkbox';
    lbl.append(removeChk, document.createTextNode('En vez de eso, quitarle la contraseña (entrará solo eligiendo su nombre)'));
    body.appendChild(lbl);
  }

  let temp = null;
  const done = await uiDialog({
    title: `Clave temporal — ${nombre}`,
    tone: 'warning',
    body,
    confirmText: 'Continuar',
    onConfirm: async () => {
      try {
        if (removeChk && removeChk.checked) await sbRpc('set_user_password', { p_nombre: nombre, p_new_password: null });
        else temp = await sbRpc('acct_reset_password', { p_nombre: nombre });
        return null;
      } catch (err) {
        return (err && err.message) || 'No se pudo cambiar la contraseña, intenta de nuevo.';
      }
    },
  });
  if (!done) return;
  await acctAfterChange();   // el login refleja si la cuenta tiene o no contraseña
  if (temp) await acctShowTempPassword(nombre, temp);
}

async function acctShowTempPassword(nombre, temp) {
  const body = uiEl('div', 'acct-temp');
  body.appendChild(uiEl('div', 'acct-temp-code', temp));
  await uiDialog({
    title: 'Clave temporal lista',
    message: `Pásasela a ${nombre} por un chat privado. Por seguridad no se vuelve a mostrar: si se pierde, genera otra.`,
    tone: 'success',
    body,
    confirmText: 'Listo',
    cancelText: null,
    dismissible: false,
    extraButton: {
      text: '📋 Copiar',
      onClick: async (e) => {
        const btn = e.currentTarget;
        btn.textContent = (await acctCopyText(temp)) ? '✓ Copiada' : 'No se pudo copiar';
      },
    },
  });
}

async function acctCopyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (err) {
    console.error('Error copiando:', err);
    return false;
  }
}

/* ══════════════════════════════
   CREAR / EDITAR CUENTA — en un diálogo
══════════════════════════════ */
function acctStartCreate() { acctOpenForm(null); }
function acctStartEdit(nombre) { acctOpenForm(nombre); }

function acctFormField(label, control, full = false) {
  const wrap = uiEl('div', `acct-form-field${full ? ' is-full' : ''}`);
  wrap.appendChild(uiEl('span', 'field-label', label));
  wrap.appendChild(control);
  return wrap;
}

function acctSelect(options, value) {
  const sel = uiEl('select', 'form-input');
  options.forEach(([v, t]) => { const o = uiEl('option', null, t); o.value = v; sel.appendChild(o); });
  sel.value = value;
  return sel;
}

async function acctOpenForm(originalNombre) {
  const isNew = originalNombre === null;
  const prev = isNew ? null : acctList.find(a => a.nombre === originalNombre);
  if (!isNew && !prev) return;

  const body = uiEl('div', 'acct-form-grid');
  const fNombre = uiEl('input', 'form-input'); fNombre.type = 'text'; fNombre.value = prev ? prev.nombre : ''; fNombre.autocomplete = 'off';
  const fPerop = uiEl('input', 'form-input'); fPerop.type = 'text'; fPerop.value = prev ? prev.perop1am : ''; fPerop.placeholder = 'PEROP1AM-00000'; fPerop.autocomplete = 'off';
  const fCargo = acctSelect(ACCT_CARGOS.map(c => [c, c]), prev ? (prev.cargo || 'Operador') : 'Operador');
  const fGenero = acctSelect([['M', 'Masculino'], ['F', 'Femenino']], prev ? (prev.genero || 'M') : 'M');
  body.append(acctFormField('Nombre completo', fNombre, true), acctFormField('PEROP1AM', fPerop), acctFormField('Cargo', fCargo),
    acctFormField('Género', fGenero));
  if (!isNew && acctCode(prev)) {
    const code = uiEl('div', 'acct-form-code'); code.appendChild(uiEl('span', 'acct-code', acctCode(prev)));
    body.appendChild(acctFormField('Código (no cambia)', code));
  }

  let fTemp = null;
  if (isNew) {
    const lbl = uiEl('label', 'check-label acct-form-temp is-full');
    fTemp = uiEl('input'); fTemp.type = 'checkbox'; fTemp.checked = true;
    lbl.append(fTemp, document.createTextNode('Generar una clave temporal al crearla (obligatorio para Supervisores)'));
    body.appendChild(lbl);
    body.appendChild(uiEl('small', 'acct-f-pass-hint is-full', 'Se muestra una sola vez para que se la pases por privado. El código de cuenta (GC-…) lo pone Supabase solo.'));
  } else {
    body.appendChild(uiEl('small', 'acct-f-pass-hint is-full', 'La contraseña no se cambia aquí: usa 🔑 Clave temporal en la ficha o en la lista.'));
  }

  const result = {};
  const saved = await uiDialog({
    title: isNew ? 'Nueva cuenta' : `Editar cuenta — ${originalNombre}`,
    body, wide: true,
    confirmText: isNew ? 'Crear cuenta' : 'Guardar cambios',
    focusEl: fNombre,
    onConfirm: async () => {
      const nombre = fNombre.value.trim();
      const perop = fPerop.value.trim();
      const cargo = fCargo.value;
      const genero = fGenero.value;
      if (!nombre) return 'El nombre es obligatorio.';
      if (acctList.some(a => a.nombre.toLowerCase() === nombre.toLowerCase() && a.nombre !== originalNombre)) return 'Ya existe una cuenta con ese nombre.';
      const wantsTemp = !!(fTemp && fTemp.checked);
      // Un Supervisor sin contraseña no puede entrar (lo bloquea app_login) — mejor avisar antes de crearlo así
      if (isNew && cargo === 'Supervisor' && !wantsTemp) return 'Una cuenta de Supervisor necesita contraseña: marca "Generar una clave temporal".';
      Object.assign(result, { nombre, perop, cargo, genero });
      try {
        // Todo pasa por funciones de Supabase que exigen el permiso "accounts.manage"
        if (isNew) {
          await sbRpc('acct_create', { p_nombre: nombre, p_perop1am: perop, p_cargo: cargo, p_genero: genero, p_password: null });
          if (wantsTemp) {
            try { result.temp = await sbRpc('acct_reset_password', { p_nombre: nombre }); }
            catch (err) { result.tempError = err.message || 'error desconocido'; }
          }
        } else {
          await sbRpc('acct_update', { p_nombre_original: originalNombre, p_nombre: nombre, p_perop1am: perop, p_cargo: cargo, p_genero: genero });
        }
        return null;
      } catch (err) {
        return (err && err.message) || 'No se pudo guardar, intenta de nuevo.';
      }
    },
  });
  if (!saved) return;

  // Editarse a uno mismo: si cambió el cargo la sesión ya no vale (hay que volver a entrar);
  // si solo cambió nombre/datos, se actualiza lo guardado para que la página lo muestre bien.
  if (!isNew && acctIsMe(prev)) {
    if (prev.cargo !== result.cargo) {
      clearSession();
      await uiAlert('Cambiaste tu propio cargo. Vuelve a iniciar sesión para aplicar los permisos nuevos.', { title: 'Cargo actualizado' });
      location.reload();
      return;
    }
    sessionStorage.setItem(SESSION_KEY, JSON.stringify([result.nombre, result.perop, result.cargo, result.genero]));
    document.getElementById('topbar-username').textContent = result.nombre;
  }

  await acctAfterChange();
  if (result.temp) await acctShowTempPassword(result.nombre, result.temp);
  else if (result.tempError) {
    uiAlert(`La cuenta se creó, pero no se pudo generar la clave temporal: ${result.tempError}. Usa 🔑 Clave temporal en su ficha.`, { title: 'Falta la clave', tone: 'warning' });
  } else if (!isNew && result.cargo === 'Supervisor' && prev.cargo !== 'Supervisor' && !prev.tieneClave) {
    uiAlert(`"${result.nombre}" ahora es Supervisor, pero no tiene contraseña: no podrá entrar hasta que le generes una con 🔑 Clave temporal.`, { title: 'Falta la contraseña', tone: 'warning' });
  }
}

/* ══════════════════════════════
   ELIMINAR
══════════════════════════════ */
async function acctDeleteAccount(nombre) {
  const u = acctList.find(a => a.nombre === nombre);
  if (u && acctIsMe(u)) {
    uiAlert('No puedes eliminar tu propia cuenta mientras tienes la sesión abierta.', { title: 'No se puede eliminar', tone: 'warning' });
    return;
  }
  const code = u ? acctCode(u) : '';
  const ok = await uiConfirm(`Se eliminará la cuenta de "${nombre}"${code ? ` (${code})` : ''}. Esta acción no se puede deshacer; su código no se vuelve a usar.`, {
    title: '¿Eliminar cuenta?', confirmText: 'Eliminar cuenta', danger: true,
  });
  if (!ok) return;

  try {
    await sbRpc('acct_delete', { p_nombre: nombre });
    await acctAfterChange();
  } catch (err) {
    console.error('Error eliminando cuenta:', err);
    uiAlert(`No se pudo eliminar la cuenta: ${(err && err.message) || 'intenta de nuevo.'}`, { title: 'Error', tone: 'danger' });
  }
}
