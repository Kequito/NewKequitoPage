/* Sesión: login en 3 pasos, entrada/salida del dashboard y helpers de permisos por cargo. */

/* ══════════════════════════════
   SESSION — LOGIN SYSTEM
══════════════════════════════ */
const SESSION_KEY     = 'gc_session';

let sessionUsers    = [];   // parsed from DTSESSION
let loginCargo      = null; // 'Team Leader' | 'Supervisor'
let loginSelectedUser = null;

/* SVG siluetas */
const SVG_MALE = `<svg viewBox="0 0 24 24" fill="currentColor" style="color:#4c8dff">
  <circle cx="12" cy="7" r="4"/>
  <path d="M12 13c-4 0-8 1.8-8 4v1h16v-1c0-2.2-4-4-8-4z"/>
</svg>`;
const SVG_FEMALE = `<svg viewBox="0 0 24 24" fill="currentColor" style="color:#e864c8">
  <circle cx="12" cy="6" r="3.5"/>
  <path d="M12 11c-3.5 0-6 1.6-6 3.5V16h3v4h6v-4h3v-1.5c0-1.9-2.5-3.5-6-3.5z"/>
</svg>`;

function silhouetteHTML(genero, extraClass='') {
  const g = (genero||'').toUpperCase().trim();
  const cls = g === 'F' ? 'female' : 'male';
  const svg = g === 'F' ? SVG_FEMALE : SVG_MALE;
  return `<div class="user-silhouette ${cls} ${extraClass}">${svg}</div>`;
}

/* ── Load users from dt_session_public (Supabase) ── */
/* dt_session_public es una VIEW sin la columna de contraseña — nunca la exponemos al navegador */
async function loadSessionUsers() {
  try {
    const data = await sbFetch('dt_session_public', 'select=NOMBRE,PEROP1AM,CARGO,GENERO,TIENE_CLAVE&order=NOMBRE.asc');
    // Normalizar a array [NOMBRE, PEROP1AM, CARGO, GENERO, tieneClave]
    sessionUsers = data.map(r => [
      r.NOMBRE   || '',
      r.PEROP1AM || '',
      r.CARGO    || '',
      r.GENERO   || '',
      !!r.TIENE_CLAVE
    ]).filter(r => r[0].trim() !== '');
  } catch(e) {
    console.error('Error cargando usuarios:', e);
  }
  checkExistingSession();
}

/* ── Check sessionStorage for existing session ── */
function checkExistingSession() {
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (stored) {
    try {
      const user = JSON.parse(stored);
      enterDashboard(user);
      return;
    } catch {}
  }
  // No session → show login
  goLoginStep('cargo');
}

/* ── Step navigation ── */
function goLoginStep(step) {
  document.querySelectorAll('.login-step').forEach(s => s.classList.remove('active'));
  // dots
  const stepOrder = ['cargo','usuario','password'];
  const idx = stepOrder.indexOf(step);
  document.querySelectorAll('.step-dot').forEach((d, i) => {
    d.classList.remove('active','done');
    if (i < idx) d.classList.add('done');
    else if (i === idx) d.classList.add('active');
  });

  if (step === 'cargo') {
    document.getElementById('lstep-cargo').classList.add('active');
  } else if (step === 'usuario') {
    renderUserGrid();
    document.getElementById('lstep-usuario').classList.add('active');
  } else if (step === 'password') {
    renderPasswordStep();
    document.getElementById('lstep-password').classList.add('active');
    setTimeout(() => document.getElementById('pass-input').focus(), 100);
  }
}

/* ── Step 1: Select cargo ── */
function selectCargo(cargo) {
  loginCargo = cargo;
  loginSelectedUser = null;
  goLoginStep('usuario');
}

/* ── Step 2: Render user cards filtered by cargo ── */
function renderUserGrid() {
  const filtered = sessionUsers.filter(u =>
    (u[2]||'').trim().toLowerCase() === loginCargo.toLowerCase()
  );
  const grid = document.getElementById('login-user-grid');
  if (filtered.length === 0) {
    grid.innerHTML = `<div style="color:var(--nav-muted);font-size:13px;padding:20px">
      No hay usuarios registrados para este cargo.</div>`;
  } else {
    grid.innerHTML = filtered.map((u, i) => {
      const genero = (u[3]||'').toUpperCase().trim();
      const cls    = genero === 'F' ? 'female' : 'male';
      const svg    = genero === 'F' ? SVG_FEMALE : SVG_MALE;
      return `<div class="user-card" onclick="selectUser(${sessionUsers.indexOf(u)}, this)">
        <div class="user-silhouette ${cls}">${svg}</div>
        <div class="user-card-name">${u[0]}</div>
        <div class="user-card-perop">${u[1]||''}</div>
      </div>`;
    }).join('');
  }
  document.getElementById('btn-continuar').disabled = true;
  loginSelectedUser = null;
}

/* ── Select a user card ── */
function selectUser(idx, el) {
  document.querySelectorAll('.user-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  loginSelectedUser = sessionUsers[idx];
  document.getElementById('btn-continuar').disabled = false;
}

/* ── Continue from user step ── */
function continueFromUser() {
  if (!loginSelectedUser) return;
  // La contraseña ahora es por cuenta (TIENE_CLAVE), no fija por cargo —
  // un Supervisor puede quedar sin contraseña y un Team Leader puede tener una, según se configure.
  if (loginSelectedUser[4]) {
    goLoginStep('password');
  } else {
    enterDashboard(loginSelectedUser);
  }
}

/* ── Step 3: Password ── */
function renderPasswordStep() {
  const u = loginSelectedUser;
  const genero = (u[3]||'').toUpperCase().trim();
  const cls = genero === 'F' ? 'female' : 'male';
  const svg = genero === 'F' ? SVG_FEMALE : SVG_MALE;
  document.getElementById('pass-silhouette').className = `user-silhouette ${cls}`;
  document.getElementById('pass-silhouette').innerHTML = svg;
  document.getElementById('pass-nombre').textContent = u[0];
  document.getElementById('pass-perop').textContent  = u[1] || '';
  document.getElementById('pass-input').value = '';
  document.getElementById('pass-error').textContent  = '';
}

/* La contraseña nunca llega al navegador: verify_login() corre en Supabase
   (SECURITY DEFINER) contra clave_hash y solo devuelve datos del usuario si coincide. */
async function submitPassword() {
  const input = document.getElementById('pass-input').value.trim();
  const err = document.getElementById('pass-error');
  const inp = document.getElementById('pass-input');
  const btn = document.querySelector('#lstep-password .login-btn-primary');
  err.textContent = '';
  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`${SB_URL}/rest/v1/rpc/verify_login`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_nombre: loginSelectedUser[0], p_password: input }),
    });
    if (!res.ok) throw new Error(`verify_login ${res.status}`);
    const rows = await res.json();

    if (rows && rows.length > 0) {
      const u = rows[0];
      enterDashboard([u.NOMBRE, u.PEROP1AM, u.CARGO, u.GENERO]);
    } else {
      err.textContent = 'Contraseña incorrecta. Inténtalo de nuevo.';
      inp.style.borderColor = 'var(--red)';
      inp.value = '';
      setTimeout(() => { err.textContent = ''; inp.style.borderColor = ''; }, 2500);
    }
  } catch (e) {
    err.textContent = 'Error de conexión. Intenta de nuevo.';
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ── Enter dashboard ── */
function enterDashboard(user) {
  // Save to sessionStorage (persists until tab/browser closes)
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(user));

  // Update topbar
  const genero = (user[3]||'').toUpperCase().trim();
  const avatarCls = genero === 'F' ? 'female' : 'male';
  const avatarSVG = genero === 'F'
    ? `<svg viewBox="0 0 24 24" fill="#e864c8"><circle cx="12" cy="6" r="3.5"/><path d="M12 11c-3.5 0-6 1.6-6 3.5V16h3v4h6v-4h3v-1.5c0-1.9-2.5-3.5-6-3.5z"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="#4c8dff"><circle cx="12" cy="7" r="4"/><path d="M12 13c-4 0-8 1.8-8 4v1h16v-1c0-2.2-4-4-8-4z"/></svg>`;

  const avatar = document.getElementById('topbar-avatar');
  avatar.className = `topbar-user-avatar ${avatarCls}`;
  avatar.innerHTML = avatarSVG;
  document.getElementById('topbar-username').textContent  = user[0];
  document.getElementById('topbar-usercargo').textContent = user[2] || '';

  // Also update sidebar bottom user chip
  document.querySelector('.user-avatar').textContent =
    user[0].split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
  document.querySelector('.user-info span:first-child').textContent = user[0];
  document.querySelector('.user-info span:last-child').textContent  = user[2] || 'En línea';

  // Hide login screen
  document.getElementById('login-screen').classList.add('hidden');

  // Sidebar dinámica: pinta ya con lo que haya en memoria (para que no se vea vacía)
  // y en paralelo trae la configuración guardada en Supabase (grupos/colores compartidos).
  renderSidebar();
  loadSidebarConfig();

  // Inicio ya está activo por defecto (currentPage arranca en 'dashboard') sin pasar por setNav — cargar sus datos ahora
  if (!dashLoaded) loadDashboard();
}

/* ── Logout ── */
/* Recarga completa a propósito: la app guarda "ya cargué esto" en muchas banderas
   (opsLoaded, repLoaded, dashLoaded, etc.) que solo se resetean al abrir la página desde cero.
   Sin el reload, cambiar de cuenta dejaba visibles controles de Supervisor (formularios de subida,
   botones de editar, secciones enteras) para quien entraba después con otro cargo. */
function logoutUser() {
  if (!confirm('¿Cerrar sesión?')) return;
  sessionStorage.removeItem(SESSION_KEY);
  location.reload();
}

function isSupervisor() {
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (!stored) return false;
  try {
    const u = JSON.parse(stored);
    return (u[2] || '').trim().toLowerCase() === 'supervisor';
  } catch { return false; }
}

/* Gestión de Recalls: Supervisor y Team Leader pueden subir Excel y marcar/eliminar
   alertas revisadas. "Comparar Status" y sus "Acciones masivas" derivadas (eliminar
   por color) y el link de "Data" quedan restringidos solo a Supervisor (isSupervisor()). */
function canEditRecalls() {
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (!stored) return false;
  try {
    const u = JSON.parse(stored);
    const role = (u[2] || '').trim().toLowerCase();
    return role === 'supervisor' || role === 'team leader';
  } catch { return false; }
}

/* Stats OPs Today: Supervisor y Team Leader pueden subir Excel — solo el link de
   "Data" queda restringido a Supervisor (ver isSupervisor() en otEditDataLink). */
function canEditOpsToday() {
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (!stored) return false;
  try {
    const u = JSON.parse(stored);
    const role = (u[2] || '').trim().toLowerCase();
    return role === 'supervisor' || role === 'team leader';
  } catch { return false; }
}

function canEditLeads() {
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (!stored) return false;
  try {
    const u = JSON.parse(stored);
    const role = (u[2] || '').trim().toLowerCase();
    return role === 'supervisor' || role === 'team leader';
  } catch { return false; }
}
