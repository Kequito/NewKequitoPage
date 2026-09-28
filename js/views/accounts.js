/* Vista Gestión de Cuentas — CRUD de cuentas y contraseñas (solo Supervisores). */

/* ══════════════════════════════
   GESTIÓN DE CUENTAS (solo Supervisores)
   El "portón" de reautenticación reutiliza el mismo verify_login() del login —
   no es a prueba de balas (misma anon key para todos, como el resto de la app),
   pero exige la contraseña real del Supervisor en cada visita a esta sección,
   en vez de confiar ciegamente en lo que haya guardado en sessionStorage.
══════════════════════════════ */
let acctLoaded = false;
let acctList = [];            // [{nombre, perop1am, cargo, genero, tieneClave}]
let acctEditingNombre = null; // nombre ORIGINAL del registro en edición (null = formulario en modo "nueva cuenta")

const ACCT_CARGO_COLORS = {
  'Operador':    { bg: 'rgba(71,85,105,.10)',  color: '#475569' },
  'Team Leader': { bg: 'rgba(37,99,235,.10)',  color: '#2563eb' },
  'Supervisor':  { bg: 'rgba(22,163,74,.10)',  color: '#16a34a' },
};
/* Devuelve "status — mensaje real de Postgres/PostgREST" en vez de un status pelado,
   para no tener que adivinar la causa (RLS, constraint, etc.) cuando algo falla. */
async function acctErrorDetail(res) {
  const text = await res.text().catch(() => '');
  return `${res.status}${text ? ` — ${text}` : ''}`;
}

function acctCargoBadge(cargo) {
  const c = ACCT_CARGO_COLORS[cargo] || { bg: 'var(--main-bg)', color: 'var(--text-mid)' };
  return `<span style="display:inline-block;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:700;background:${c.bg};color:${c.color}">${cargo || '—'}</span>`;
}

const ACCT_PERMISSIONS = [
  { label: 'Ver todas las secciones (Inicio, GoodDay, Approve Stats, Reporte, Recalls, Top Team Leader)', op: true,  tl: true,  sup: true },
  { label: 'Subir Excel / actualizar data (Actualización de Data)', op: false, tl: false, sup: true },
  { label: 'Guardar snapshot en Reporte', op: false, tl: false, sup: true },
  { label: 'Subir Excel y acciones masivas en Recalls', op: false, tl: false, sup: true },
  { label: 'Guardar avance / Banear-Restaurar en Top Team Leader', op: false, tl: false, sup: true },
  { label: 'Gestión de Cuentas (esta sección)', op: false, tl: false, sup: true },
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
  const stored = sessionStorage.getItem(SESSION_KEY);
  const me = stored ? JSON.parse(stored) : null;
  const pass = document.getElementById('acct-gate-pass').value;
  const err = document.getElementById('acct-gate-error');
  err.textContent = '';
  if (!me || !pass) { err.textContent = 'Ingresa tu contraseña.'; return; }

  try {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/verify_login`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_nombre: me[0], p_password: pass }),
    });
    if (!res.ok) throw new Error(`verify_login ${res.status}`);
    const rows = await res.json();
    if (!rows || rows.length === 0) {
      err.textContent = 'Contraseña incorrecta.';
      return;
    }
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
    const safe = u.nombre.replace(/'/g, "\\'");
    return `<tr>
      <td style="display:flex;align-items:center;gap:8px">${silhouetteHTML(u.genero, 'acct-avatar')}<span style="font-weight:600">${u.nombre}</span></td>
      <td>${u.perop1am || '—'}</td>
      <td>${acctCargoBadge(u.cargo)}</td>
      <td>${u.tieneClave ? '<span class="badge badge-green">✓ Sí</span>' : '<span style="color:var(--text-light)">— No</span>'}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-ghost btn-sm" onclick="acctStartEdit('${safe}')">✎ Editar</button>
        <button class="btn btn-ghost btn-sm" onclick="acctChangePassword('${safe}', ${u.tieneClave})">🔑 ${u.tieneClave ? 'Cambiar' : 'Poner'}</button>
        <button class="btn btn-ghost btn-sm" onclick="acctDeleteAccount('${safe}')" style="color:var(--red)">🗑 Eliminar</button>
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
  const res = await fetch(`${SB_URL}/rest/v1/rpc/set_user_password`, {
    method: 'POST',
    headers: { ...SB_HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_nombre: nombre, p_new_password: password || null }),
  });
  if (!res.ok) throw new Error(`set_user_password error ${await acctErrorDetail(res)}`);
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

  const btn = document.getElementById('acct-form-submit');
  btn.disabled = true;
  try {
    if (isNew) {
      const res = await fetch(`${SB_URL}/rest/v1/dt_session`, {
        method: 'POST',
        headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify([{ NOMBRE: nombre, PEROP1AM: perop, CARGO: cargo, GENERO: genero }]),
      });
      if (!res.ok) throw new Error(`Supabase insert error ${await acctErrorDetail(res)}`);

      const wantsPass = document.getElementById('acct-f-haspass').checked;
      const pass = document.getElementById('acct-f-pass').value;
      if (wantsPass && pass) await acctCallSetPassword(nombre, pass);
    } else {
      const res = await fetch(`${SB_URL}/rest/v1/dt_session?NOMBRE=eq.${encodeURIComponent(acctEditingNombre)}`, {
        method: 'PATCH',
        headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
        body: JSON.stringify({ NOMBRE: nombre, PEROP1AM: perop, CARGO: cargo, GENERO: genero }),
      });
      if (!res.ok) throw new Error(`Supabase update error ${await acctErrorDetail(res)}`);
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
  const next = prompt(
    `${hasPassword ? 'Nueva' : 'Asignar'} contraseña para "${nombre}"\n(déjalo vacío para QUITAR la contraseña — entrará solo eligiendo su nombre):`,
    ''
  );
  if (next === null) return; // canceló

  if (next === '' && hasPassword) {
    if (!confirm(`¿Quitar la contraseña de "${nombre}"? Podrá entrar solo eligiendo su nombre, sin contraseña.`)) return;
  }

  try {
    await acctCallSetPassword(nombre, next);
    await acctLoadList();
    await loadSessionUsers();
  } catch (err) {
    console.error('Error cambiando contraseña:', err);
    alert(`No se pudo actualizar la contraseña: ${(err && err.message) || 'intenta de nuevo.'}`);
  }
}

async function acctDeleteAccount(nombre) {
  const stored = sessionStorage.getItem(SESSION_KEY);
  const me = stored ? JSON.parse(stored) : null;
  if (me && me[0] === nombre) { alert('No puedes eliminar tu propia cuenta mientras tienes la sesión abierta.'); return; }
  if (!confirm(`¿Eliminar la cuenta de "${nombre}"? Esta acción no se puede deshacer.`)) return;

  try {
    const res = await fetch(`${SB_URL}/rest/v1/dt_session?NOMBRE=eq.${encodeURIComponent(nombre)}`, {
      method: 'DELETE',
      headers: SB_HEADERS,
    });
    if (!res.ok) throw new Error(`Supabase delete error ${await acctErrorDetail(res)}`);
    await acctLoadList();
    await loadSessionUsers();
  } catch (err) {
    console.error('Error eliminando cuenta:', err);
    alert(`No se pudo eliminar la cuenta: ${(err && err.message) || 'intenta de nuevo.'}`);
  }
}
