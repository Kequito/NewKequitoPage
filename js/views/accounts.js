/* Vista Gestión de Cuentas — CRUD de cuentas y contraseñas (solo Supervisores). */

/* ══════════════════════════════
   GESTIÓN DE CUENTAS (solo Supervisores)
   El "portón" pide la contraseña del Supervisor en cada visita (hace un app_login nuevo).
   La protección real está en Supabase: crear/editar/eliminar cuentas y cambiar contraseñas
   pasa por funciones (acct_*, set_user_password) que exigen un token de Supervisor —
   ver supabase/01_sesiones.sql y 02_bloqueo.sql.
══════════════════════════════ */
let acctLoaded = false;
let acctList = [];            // [{nombre, perop1am, cargo, genero, tieneClave}]
let acctEditingNombre = null; // nombre ORIGINAL del registro en edición (null = formulario en modo "nueva cuenta")

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

/* Tabla de referencia — solo informativa. Los permisos reales viven en core/session.js
   (isSupervisor / canEdit*) y en supervisorOnly de core/sidebar.js: mantener ambos en sync. */
const ACCT_PERMISSIONS = [
  { label: 'Entrar al panel (el login solo ofrece Team Leader y Supervisor; un Supervisor siempre necesita contraseña)', op: false, tl: true, sup: true },
  { label: 'Ver Inicio, GoodDay, Approve Stats, Stats OPs Today, Reporte, Recalls, Leads y Top Team Leader', op: false, tl: true, sup: true },
  { label: 'Subir Excel en Stats OPs Today', op: false, tl: true, sup: true },
  { label: 'Recalls: subir Excel y marcar / eliminar alertas revisadas', op: false, tl: true, sup: true },
  { label: 'Leads por Campaña: guardar la data pegada', op: false, tl: true, sup: true },
  { label: 'Recalls: Comparar Status y eliminar por color', op: false, tl: false, sup: true },
  { label: 'Editar los links de "Data" (Recalls, Stats OPs Today, Leads)', op: false, tl: false, sup: true },
  { label: 'Reporte: pegar datos y guardar snapshot', op: false, tl: false, sup: true },
  { label: 'Top Team Leader: guardar avance y banear / restaurar', op: false, tl: false, sup: true },
  { label: 'Actualización de Data', op: false, tl: false, sup: true },
  { label: 'Gestión de Cuentas (esta sección) y Configurar Sidebar', op: false, tl: false, sup: true },
];
function renderAcctPermissions() {
  const tbody = document.getElementById('acct-perm-tbody');
  const mark = v => v ? '<span style="color:var(--green);font-weight:700">✓</span>' : '<span style="color:var(--text-light)">—</span>';
  tbody.innerHTML = ACCT_PERMISSIONS.map(p => `<tr>
    <td>${p.label}</td>
    <td style="text-align:center">${mark(p.op)}</td>
    <td style="text-align:center">${mark(p.tl)}</td>
    <td style="text-align:center">${mark(p.sup)}</td>
  </tr>`).join('');
}

function loadAccountsView() {
  acctLoaded = true;
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
    renderAcctPermissions();
    await acctLoadList();
  } catch (e) {
    err.textContent = 'Error de conexión, intenta de nuevo.';
  }
}

async function acctLoadList() {
  try {
    const data = await sbFetch('dt_session_public', 'select=NOMBRE,PEROP1AM,CARGO,GENERO,TIENE_CLAVE&order=NOMBRE.asc');
    acctList = data.map(r => ({
      nombre: r.NOMBRE || '', perop1am: r.PEROP1AM || '', cargo: r.CARGO || '', genero: r.GENERO || '',
      tieneClave: !!r.TIENE_CLAVE,
    }));
    renderAcctTable();
  } catch (err) {
    console.error('Error cargando cuentas:', err);
  }
}

function renderAcctTable() {
  const tbody = document.getElementById('acct-tbody');
  tbody.innerHTML = acctList.map(u => {
    const nameArg = jsArg(u.nombre);
    return `<tr>
      <td style="display:flex;align-items:center;gap:8px">${silhouetteHTML(u.genero, 'acct-avatar')}<span style="font-weight:600">${escapeHtml(u.nombre)}</span></td>
      <td>${escapeHtml(u.perop1am) || '—'}</td>
      <td>${acctCargoBadge(u.cargo)}</td>
      <td>${u.tieneClave ? '<span class="badge badge-green">✓ Sí</span>' : '<span style="color:var(--text-light)">— No</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="acctStartEdit(${nameArg})">✎ Editar</button>
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
    errBox.textContent = 'Una cuenta de Supervisor necesita contraseña: marca "Con contraseña" y escríbela.';
    errBox.style.display = 'block';
    return;
  }

  const me = getCurrentUser();
  const editingSelf = !isNew && me && me[0] === acctEditingNombre;
  const prev = isNew ? null : acctList.find(a => a.nombre === acctEditingNombre);

  const btn = document.getElementById('acct-form-submit');
  btn.disabled = true;
  try {
    // Todo pasa por funciones de Supabase que exigen token de Supervisor (supabase/01_sesiones.sql)
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
