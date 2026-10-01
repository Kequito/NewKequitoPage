/* Vista Gestión de Cuentas — cuentas, contraseñas y PERMISOS (por cargo y por cuenta).
   Requiere el permiso "accounts.manage". */

/* ══════════════════════════════
   GESTIÓN DE CUENTAS
   El "portón" pide la contraseña de quien entra en cada visita (hace un app_login nuevo).
   La protección real está en Supabase: crear/editar/eliminar cuentas, cambiar contraseñas y
   editar permisos pasa por funciones (acct_*, set_user_password, perm_*) que exigen el permiso
   "accounts.manage" — ver supabase/03_permisos.sql.
══════════════════════════════ */
let acctLoaded = false;
let acctList = [];            // [{nombre, perop1am, cargo, genero, tieneClave}]
let acctEditingNombre = null; // nombre ORIGINAL del registro en edición (null = formulario en modo "nueva cuenta")

let permRoles = {};           // guardado:  { 'supervisor': Set, 'team leader': Set, 'operador': Set }
let permRoleDraft = {};       // en edición (lo que muestran las casillas)
let permAccounts = new Map(); // nombre → { extra: {perm: bool}, hasPass, effective: Set }
let permAvailable = true;     // false si Supabase todavía no tiene 03_permisos.sql
let acctStatus = new Map();   // nombre → { codigo, tiene_clave, clave_temporal, clave_cambiada_at, bloqueado_hasta } (script 08)

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

function renderPermRoleMatrix() {
  const warn = document.getElementById('perm-role-warn');
  warn.hidden = permAvailable;
  if (!permAvailable) warn.textContent = 'Supabase todavía no tiene la configuración de permisos (supabase/03_permisos.sql). Se muestran los valores por defecto y no se pueden guardar cambios.';

  const tbody = document.getElementById('perm-role-tbody');
  tbody.innerHTML = PERM_GROUPS.map(g => {
    const rows = PERM_CATALOG.filter(p => p.group === g.id).map(p => `<tr>
      <td>${escapeHtml(p.label)}${p.sensitive ? ' <span class="perm-lock" title="Sensible: solo funciona en cuentas con contraseña">🔒</span>' : ''}</td>
      ${PERM_ROLES.map(r => `<td class="text-center">
        <input type="checkbox" class="perm-check" ${permRoleDraft[r.key]?.has(p.key) ? 'checked' : ''} ${permAvailable ? '' : 'disabled'}
          aria-label="${escapeHtml(`${r.label}: ${p.label}`)}" onchange="permRoleToggle(${jsArg(r.key)}, ${jsArg(p.key)}, this.checked)"/>
      </td>`).join('')}
    </tr>`).join('');
    return `<tr class="perm-group-row"><td colspan="${PERM_ROLES.length + 1}">${escapeHtml(g.label)}</td></tr>${rows}`;
  }).join('');
  permRoleUpdateButtons();
}

function permRoleToggle(role, perm, on) {
  const set = permRoleDraft[role] || (permRoleDraft[role] = new Set());
  on ? set.add(perm) : set.delete(perm);
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
  renderAcctTable();
  await permLoad();
  renderSidebar();
  if (!canSeePage(currentPage)) { const first = firstAllowedPage(); if (first) goToPage(first); }
}

/* Celda "Permisos" de la tabla de cuentas */
function acctPermCell(u) {
  if (!permAvailable) return '<span class="muted-11">—</span>';
  const info = permAccounts.get(u.nombre);
  const n = info ? Object.keys(info.extra || {}).length : 0;
  return n
    ? `<span class="badge badge-amber" title="Tiene excepciones propias sobre los permisos de su cargo">Personalizado (${n})</span>`
    : '<span class="muted-11">Según cargo</span>';
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
    await acctLoadList();
  } catch (e) {
    err.textContent = loginErrorText(e);
  }
}

async function acctLoadList() {
  try {
    const [data, status] = await Promise.all([
      sbFetch('dt_session_public', 'select=NOMBRE,PEROP1AM,CARGO,GENERO,TIENE_CLAVE&order=NOMBRE.asc'),
      // Código y estado de la clave: si falta el script 08, la tabla sigue funcionando sin esas columnas
      sbRpc('acct_status_list').catch(err => { console.warn('Cuentas: falta el script 08 (claves y códigos)', err); return null; }),
      permLoadAll(),
    ]);
    acctStatus = new Map((status || []).map(s => [s.nombre, s]));
    acctList = data.map(r => ({
      nombre: r.NOMBRE || '', perop1am: r.PEROP1AM || '', cargo: r.CARGO || '', genero: r.GENERO || '',
      tieneClave: !!r.TIENE_CLAVE,
    }));
    renderAcctTable();
    renderPermRoleMatrix();
  } catch (err) {
    console.error('Error cargando cuentas:', err);
  }
}

function renderAcctTable() {
  const tbody = document.getElementById('acct-tbody');
  const q = (document.getElementById('acct-search').value || '').trim().toLowerCase();
  const cargo = document.getElementById('acct-f-filter-cargo').value;
  const codeOf = u => (acctStatus.get(u.nombre) || {}).codigo || '';
  const rows = acctList.filter(u =>
    (!cargo || u.cargo === cargo) &&
    (!q || `${u.nombre} ${u.perop1am} ${codeOf(u)}`.toLowerCase().includes(q)));
  document.getElementById('acct-count').textContent = `(${rows.length}${rows.length !== acctList.length ? ` de ${acctList.length}` : ''})`;
  const me = getCurrentUser();
  tbody.innerHTML = rows.map(u => {
    const nameArg = jsArg(u.nombre);
    const isMe = !!(me && me[0] === u.nombre);
    return `<tr>
      <td>${codeOf(u) ? `<span class="acct-code">${escapeHtml(codeOf(u))}</span>` : '<span class="txt-light">—</span>'}</td>
      <td><div class="acct-name-cell">${silhouetteHTML(u.genero, 'acct-avatar')}<span class="acct-name">${escapeHtml(u.nombre)}</span>${isMe ? ' <span class="tl-you">Tú</span>' : ''}</div></td>
      <td>${escapeHtml(u.perop1am) || '—'}</td>
      <td>${acctCargoBadge(u.cargo)}</td>
      <td>${acctPassCell(u)}</td>
      <td>${acctPermCell(u)}</td>
      <td class="acct-actions">
        <button class="btn btn-ghost btn-sm" onclick="acctStartEdit(${nameArg})">✎ Editar</button>
        <button class="btn btn-ghost btn-sm" onclick="acctEditPerms(${nameArg})">🛡 Permisos</button>
        ${isMe
          ? '<button class="btn btn-ghost btn-sm" onclick="myAccountChangePassword()" title="Tu propia contraseña se cambia sabiendo la actual">🔑 Mi contraseña</button>'
          : `<button class="btn btn-ghost btn-sm" onclick="acctResetPassword(${nameArg})" title="Genera una clave temporal para pasársela por privado">🔑 Clave temporal</button>`}
        <button class="btn btn-ghost btn-sm acct-del" onclick="acctDeleteAccount(${nameArg})">🗑 Eliminar</button>
      </td>
    </tr>`;
  }).join('');
}

function acctFmtDateTime(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}

/* Celda "Contraseña": propia / temporal / sin contraseña, cuándo se cambió y si está bloqueada.
   Nunca se muestra la contraseña: Supabase solo guarda su hash. */
function acctPassCell(u) {
  const s = acctStatus.get(u.nombre);
  if (!s) return u.tieneClave ? '<span class="badge badge-green">✓ Sí</span>' : '<span class="txt-light">— No</span>';
  const when = s.clave_cambiada_at ? acctFmtDateTime(s.clave_cambiada_at) : '';
  let html;
  if (!s.tiene_clave) html = '<span class="txt-light">— Sin contraseña</span>';
  else if (s.clave_temporal) html = `<span class="badge badge-amber" title="Clave temporal: al entrar con ella se le pide crear una propia">⏳ Temporal</span>`;
  else html = '<span class="badge badge-green" title="La puso la misma persona">✓ Propia</span>';
  if (s.tiene_clave && when) html += `<div class="acct-pass-when">${s.clave_temporal ? 'generada' : 'cambiada'} el ${escapeHtml(when)}</div>`;
  if (s.bloqueado_hasta) {
    const until = new Date(s.bloqueado_hasta).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    html += `<div class="acct-locked">🔒 Bloqueada hasta las ${until} (intentos fallidos)
      <button class="btn btn-ghost btn-sm" onclick="acctUnlock(${jsArg(u.nombre)})">Desbloquear</button></div>`;
  }
  return html;
}

async function acctUnlock(nombre) {
  try {
    await sbRpc('acct_unlock', { p_nombre: nombre });
    await acctLoadList();
  } catch (err) {
    console.error('Error desbloqueando cuenta:', err);
    uiAlert(`No se pudo desbloquear: ${(err && err.message) || 'intenta de nuevo.'}`, { title: 'Error', tone: 'danger' });
  }
}

/* ── Clave temporal: la genera Supabase al azar, se muestra UNA sola vez ── */
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
  await acctLoadList();
  await loadSessionUsers();   // el login refleja si la cuenta tiene o no contraseña
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

function acctStartCreate() {
  acctEditingNombre = null;
  document.getElementById('acct-form-title').textContent = 'Nueva cuenta';
  document.getElementById('acct-f-nombre').value = '';
  document.getElementById('acct-f-perop').value = '';
  document.getElementById('acct-f-cargo').value = 'Operador';
  document.getElementById('acct-f-genero').value = 'M';
  document.getElementById('acct-f-haspass').checked = true;
  document.getElementById('acct-f-pass-wrap').style.display = 'block';
  document.getElementById('acct-form-error').style.display = 'none';
  document.getElementById('acct-form-panel').style.display = 'block';
}

function acctStartEdit(nombre) {
  const u = acctList.find(a => a.nombre === nombre);
  if (!u) return;
  acctEditingNombre = nombre;
  document.getElementById('acct-form-title').textContent = `Editar cuenta — ${nombre}`;
  document.getElementById('acct-f-nombre').value = u.nombre;
  document.getElementById('acct-f-perop').value = u.perop1am;
  document.getElementById('acct-f-cargo').value = u.cargo || 'Operador';
  document.getElementById('acct-f-genero').value = u.genero || 'M';
  // La contraseña se cambia aparte (botón "Clave temporal" en la tabla), no se toca en este formulario
  document.getElementById('acct-f-pass-wrap').style.display = 'none';
  document.getElementById('acct-form-error').style.display = 'none';
  document.getElementById('acct-form-panel').style.display = 'block';
}

function acctCloseForm() {
  document.getElementById('acct-form-panel').style.display = 'none';
}

async function acctSubmitForm() {
  const nombre = document.getElementById('acct-f-nombre').value.trim();
  const perop  = document.getElementById('acct-f-perop').value.trim();
  const cargo  = document.getElementById('acct-f-cargo').value;
  const genero = document.getElementById('acct-f-genero').value;
  const errBox = document.getElementById('acct-form-error');
  errBox.style.display = 'none';

  if (!nombre) { errBox.textContent = 'El nombre es obligatorio.'; errBox.style.display = 'block'; return; }

  const isNew = acctEditingNombre === null;
  const dupExists = acctList.some(a => a.nombre.toLowerCase() === nombre.toLowerCase() && a.nombre !== acctEditingNombre);
  if (dupExists) { errBox.textContent = 'Ya existe una cuenta con ese nombre.'; errBox.style.display = 'block'; return; }

  const wantsTemp = document.getElementById('acct-f-haspass').checked;
  // Un Supervisor sin contraseña no puede entrar (lo bloquea app_login) — mejor avisar antes de crearlo así
  if (isNew && cargo === 'Supervisor' && !wantsTemp) {
    errBox.textContent = 'Una cuenta de Supervisor necesita contraseña: marca "Generar una clave temporal al crearla".';
    errBox.style.display = 'block';
    return;
  }

  const me = getCurrentUser();
  const editingSelf = !isNew && me && me[0] === acctEditingNombre;
  const prev = isNew ? null : acctList.find(a => a.nombre === acctEditingNombre);

  const btn = document.getElementById('acct-form-submit');
  btn.disabled = true;
  let temp = null;
  try {
    // Todo pasa por funciones de Supabase que exigen el permiso "accounts.manage" (supabase/03_permisos.sql)
    if (isNew) {
      await sbRpc('acct_create', { p_nombre: nombre, p_perop1am: perop, p_cargo: cargo, p_genero: genero, p_password: null });
      // El código (GC-0001…) lo pone Supabase solo. La clave temporal se genera aparte, también en Supabase.
      if (wantsTemp) {
        try {
          temp = await sbRpc('acct_reset_password', { p_nombre: nombre });
        } catch (err) {
          acctCloseForm();
          await acctLoadList();
          await loadSessionUsers();
          uiAlert(`La cuenta se creó, pero no se pudo generar la clave temporal: ${err.message || 'error desconocido'}. Usa 🔑 Clave temporal en la tabla.`,
            { title: 'Falta la clave', tone: 'warning' });
          return;
        }
      }
    } else {
      await sbRpc('acct_update', {
        p_nombre_original: acctEditingNombre, p_nombre: nombre, p_perop1am: perop, p_cargo: cargo, p_genero: genero,
      });
    }

    // Editarse a uno mismo: si cambió el cargo la sesión ya no vale (hay que volver a entrar);
    // si solo cambió nombre/datos, se actualiza lo guardado para que la página lo muestre bien.
    if (editingSelf) {
      if (prev && prev.cargo !== cargo) {
        clearSession();
        await uiAlert('Cambiaste tu propio cargo. Vuelve a iniciar sesión para aplicar los permisos nuevos.', { title: 'Cargo actualizado' });
        location.reload();
        return;
      }
      sessionStorage.setItem(SESSION_KEY, JSON.stringify([nombre, perop, cargo, genero]));
    } else if (prev && cargo === 'Supervisor' && prev.cargo !== 'Supervisor' && !prev.tieneClave) {
      uiAlert(`"${nombre}" ahora es Supervisor, pero no tiene contraseña: no podrá entrar hasta que le generes una con 🔑 Clave temporal.`, { title: 'Falta la contraseña', tone: 'warning' });
    }

    acctCloseForm();
    await acctLoadList();
    await loadSessionUsers(); // refresca también el picker de login con el cambio
    if (temp) await acctShowTempPassword(nombre, temp);
  } catch (err) {
    console.error('Error guardando cuenta:', err);
    errBox.textContent = (err && err.message) ? err.message : 'No se pudo guardar, intenta de nuevo.';
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
}

async function acctDeleteAccount(nombre) {
  const me = getCurrentUser();
  if (me && me[0] === nombre) {
    uiAlert('No puedes eliminar tu propia cuenta mientras tienes la sesión abierta.', { title: 'No se puede eliminar', tone: 'warning' });
    return;
  }
  const ok = await uiConfirm(`Se eliminará la cuenta de "${nombre}". Esta acción no se puede deshacer.`, {
    title: '¿Eliminar cuenta?', confirmText: 'Eliminar cuenta', danger: true,
  });
  if (!ok) return;

  try {
    await sbRpc('acct_delete', { p_nombre: nombre });
    await acctLoadList();
    await loadSessionUsers();
  } catch (err) {
    console.error('Error eliminando cuenta:', err);
    uiAlert(`No se pudo eliminar la cuenta: ${(err && err.message) || 'intenta de nuevo.'}`, { title: 'Error', tone: 'danger' });
  }
}
