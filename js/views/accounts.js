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
  return `<span style="display:inline-block;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:700;background:${c.bg};color:${c.color}">${escapeHtml(cargo) || '—'}</span>`;
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
    const rows = await sbRpc('app_login', { p_nombre: me[0], p_password: pass });
    if (!rows || rows.length === 0) {
      err.textContent = 'Contraseña incorrecta.';
      return;
    }
    try { await sbRpc('app_logout'); } catch (e) { /* la vieja vence sola */ }
    saveSessionToken(rows[0].token, rows[0].expires_at);
    document.getElementById('acct-gate').style.display = 'none';
    document.getElementById('acct-content').style.display = 'block';
    await acctLoadList();
  } catch (e) {
    err.textContent = 'Error de conexión, intenta de nuevo.';
  }
}

async function acctLoadList() {
  try {
    const [data] = await Promise.all([
      sbFetch('dt_session_public', 'select=NOMBRE,PEROP1AM,CARGO,GENERO,TIENE_CLAVE&order=NOMBRE.asc'),
      permLoadAll(),
    ]);
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
  const rows = acctList.filter(u =>
    (!cargo || u.cargo === cargo) &&
    (!q || `${u.nombre} ${u.perop1am}`.toLowerCase().includes(q)));
  document.getElementById('acct-count').textContent = `(${rows.length}${rows.length !== acctList.length ? ` de ${acctList.length}` : ''})`;
  tbody.innerHTML = rows.map(u => {
    const nameArg = jsArg(u.nombre);
    return `<tr>
      <td style="display:flex;align-items:center;gap:8px">${silhouetteHTML(u.genero, 'acct-avatar')}<span style="font-weight:600">${escapeHtml(u.nombre)}</span></td>
      <td>${escapeHtml(u.perop1am) || '—'}</td>
      <td>${acctCargoBadge(u.cargo)}</td>
      <td>${u.tieneClave ? '<span class="badge badge-green">✓ Sí</span>' : '<span style="color:var(--text-light)">— No</span>'}</td>
      <td>${acctPermCell(u)}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="acctStartEdit(${nameArg})">✎ Editar</button>
        <button class="btn btn-ghost btn-sm" onclick="acctEditPerms(${nameArg})">🛡 Permisos</button>
        <button class="btn btn-ghost btn-sm" onclick="acctChangePassword(${nameArg}, ${u.tieneClave})">🔑 ${u.tieneClave ? 'Cambiar' : 'Poner'}</button>
        <button class="btn btn-ghost btn-sm" onclick="acctDeleteAccount(${nameArg})" style="color:var(--red)">🗑 Eliminar</button>
      </td>
    </tr>`;
  }).join('');
}

function acctStartCreate() {
  acctEditingNombre = null;
  document.getElementById('acct-form-title').textContent = 'Nueva cuenta';
  document.getElementById('acct-f-nombre').value = '';
  document.getElementById('acct-f-perop').value = '';
  document.getElementById('acct-f-cargo').value = 'Operador';
  document.getElementById('acct-f-genero').value = 'M';
  document.getElementById('acct-f-haspass').checked = false;
  document.getElementById('acct-f-pass').value = '';
  document.getElementById('acct-f-pass').style.display = 'none';
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
  // La contraseña se cambia aparte (botón "Cambiar/Poner" en la tabla), no se toca en este formulario
  document.getElementById('acct-f-pass-wrap').style.display = 'none';
  document.getElementById('acct-form-error').style.display = 'none';
  document.getElementById('acct-form-panel').style.display = 'block';
}

function acctCloseForm() {
  document.getElementById('acct-form-panel').style.display = 'none';
}

function acctTogglePassField() {
  const on = document.getElementById('acct-f-haspass').checked;
  document.getElementById('acct-f-pass').style.display = on ? 'block' : 'none';
}

async function acctCallSetPassword(nombre, password) {
  await sbRpc('set_user_password', { p_nombre: nombre, p_new_password: password || null });
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

  const wantsPass = document.getElementById('acct-f-haspass').checked;
  const pass = document.getElementById('acct-f-pass').value;
  // Un Supervisor sin contraseña no puede entrar (lo bloquea app_login) — mejor avisar antes de crearlo así
  if (isNew && cargo === 'Supervisor' && !(wantsPass && pass)) {
    errBox.textContent = 'Una cuenta de Supervisor necesita contraseña: marca "Asignar contraseña a esta cuenta" y escríbela.';
    errBox.style.display = 'block';
    return;
  }

  const me = getCurrentUser();
  const editingSelf = !isNew && me && me[0] === acctEditingNombre;
  const prev = isNew ? null : acctList.find(a => a.nombre === acctEditingNombre);

  const btn = document.getElementById('acct-form-submit');
  btn.disabled = true;
  try {
    // Todo pasa por funciones de Supabase que exigen el permiso "accounts.manage" (supabase/03_permisos.sql)
    if (isNew) {
      await sbRpc('acct_create', {
        p_nombre: nombre, p_perop1am: perop, p_cargo: cargo, p_genero: genero,
        p_password: (wantsPass && pass) ? pass : null,
      });
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
      uiAlert(`"${nombre}" ahora es Supervisor, pero no tiene contraseña: no podrá entrar hasta que le asignes una con 🔑 Poner.`, { title: 'Falta la contraseña', tone: 'warning' });
    }

    acctCloseForm();
    await acctLoadList();
    await loadSessionUsers(); // refresca también el picker de login con el cambio
  } catch (err) {
    console.error('Error guardando cuenta:', err);
    errBox.textContent = (err && err.message) ? err.message : 'No se pudo guardar, intenta de nuevo.';
    errBox.style.display = 'block';
  } finally {
    btn.disabled = false;
  }
}

async function acctChangePassword(nombre, hasPassword) {
  const next = await uiPrompt(
    `Cuenta: "${nombre}"\n\nDéjalo vacío para QUITAR la contraseña — entrará solo eligiendo su nombre.`,
    { title: `${hasPassword ? 'Cambiar' : 'Asignar'} contraseña`, inputType: 'password', placeholder: 'Nueva contraseña', allowEmpty: true },
  );
  if (next === null) return; // canceló

  const target = acctList.find(a => a.nombre === nombre);
  if (next === '' && target && target.cargo === 'Supervisor') {
    uiAlert('Un Supervisor no puede quedar sin contraseña: no podría volver a entrar como Supervisor.', { title: 'Contraseña obligatoria', tone: 'warning' });
    return;
  }
  if (next === '' && hasPassword) {
    const ok = await uiConfirm(`"${nombre}" podrá entrar solo eligiendo su nombre, sin contraseña.`, {
      title: '¿Quitar la contraseña?', confirmText: 'Quitar contraseña', danger: true,
    });
    if (!ok) return;
  }

  try {
    await acctCallSetPassword(nombre, next);
    // Cambiar una contraseña cierra las sesiones de esa cuenta en el servidor. Si es la propia,
    // se vuelve a entrar al toque con la clave nueva para no quedar sin permisos a mitad de camino.
    const me = getCurrentUser();
    if (me && me[0] === nombre && !(await requestLogin(nombre, next))) {
      clearSession();
      await uiAlert('Tu contraseña cambió. Vuelve a iniciar sesión con la nueva.', { title: 'Contraseña actualizada' });
      location.reload();
      return;
    }
    await acctLoadList();
    await loadSessionUsers();
  } catch (err) {
    console.error('Error cambiando contraseña:', err);
    uiAlert(`No se pudo actualizar la contraseña: ${(err && err.message) || 'intenta de nuevo.'}`, { title: 'Error', tone: 'danger' });
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
