/* Permisos editables — catálogo, cargos y la función can() que usa toda la página.
   La fuente de verdad está en Supabase (supabase/03_permisos.sql): al entrar se piden los
   permisos EFECTIVOS de la cuenta (cargo + excepciones de la cuenta). La página solo muestra u
   oculta cosas según can(); Supabase vuelve a revisar el permiso antes de dejar guardar algo.
   ⚠ Mantener PERM_CATALOG en sync con app_all_perms() / app_sensitive_perms() del SQL. */

const PERM_GROUPS = [
  { id: 'view',   label: 'Ver secciones' },
  { id: 'action', label: 'Acciones' },
];

/* sensitive = solo funciona si la cuenta tiene contraseña (lo aplica Supabase) */
const PERM_CATALOG = [
  { key: 'view.dashboard',  group: 'view',   label: 'Inicio' },
  { key: 'view.goodday',    group: 'view',   label: 'Equipos 360 (ex GoodDay)' },
  { key: 'view.ops',        group: 'view',   label: 'Approve Stats' },
  { key: 'view.opstoday',   group: 'view',   label: 'Stats OPs Today' },
  { key: 'view.opslive',    group: 'view',   label: 'Stats OPs Live' },
  { key: 'view.reportes',   group: 'view',   label: 'Reporte' },
  { key: 'view.recalls',    group: 'view',   label: 'Gestión de Recalls' },
  { key: 'view.leads',      group: 'view',   label: 'Leads por Campaña' },
  { key: 'view.ventasfuera', group: 'view',  label: 'Ventas por Fuera' },
  { key: 'view.tl',         group: 'view',   label: 'Top Team Leader' },
  { key: 'opstoday.upload', group: 'action', label: 'Subir Excel en Stats OPs Today' },
  { key: 'recalls.upload',  group: 'action', label: 'Recalls: subir Excel' },
  { key: 'recalls.review',  group: 'action', label: 'Recalls: marcar y eliminar alertas revisadas' },
  { key: 'recalls.compare', group: 'action', label: 'Recalls: Comparar Status y eliminar por color', sensitive: true },
  { key: 'leads.save',      group: 'action', label: 'Leads por Campaña: guardar data pegada' },
  { key: 'reportes.save',   group: 'action', label: 'Reporte: pegar datos y guardar (fuentes 1 a 3)' },
  { key: 'tl.manage',       group: 'action', label: 'Top Team Leader: guardar avance y banear / restaurar', sensitive: true },
  { key: 'datalinks.edit',  group: 'action', label: 'Editar los links de "Data"', sensitive: true },
  { key: 'data.upload',     group: 'action', label: 'Actualización de Data (subir Excel de GoodDay, Approve Stats, Top TL)', sensitive: true },
  { key: 'accounts.manage', group: 'action', label: 'Gestión de Cuentas y permisos', sensitive: true },
  { key: 'sidebar.manage',  group: 'action', label: 'Configurar Sidebar', sensitive: true },
];

/* Cargos que pueden entrar al panel (clave = CARGO en minúsculas) */
const PERM_ROLES = [
  { key: 'supervisor',  label: 'Supervisor' },
  { key: 'team leader', label: 'Team Leader' },
  { key: 'operador',    label: 'Operador' },
];

/* Respaldo si Supabase todavía no tiene 03_permisos.sql: mismos valores iniciales que el SQL */
const PERM_FALLBACK = {
  'supervisor':  PERM_CATALOG.map(p => p.key),
  'team leader': ['view.dashboard','view.goodday','view.ops','view.opstoday','view.opslive','view.reportes',
                  'view.recalls','view.leads','view.ventasfuera','view.tl','opstoday.upload','recalls.upload','recalls.review','leads.save',
                  'reportes.save'],
  'operador':    ['view.dashboard','view.goodday','view.opslive','view.recalls'],
};

let myPerms = new Set();

/* Pide mis permisos efectivos a Supabase (tras el login y al recargar la página) */
async function permLoad() {
  try {
    const perms = await sbRpc('app_my_permissions');
    myPerms = new Set(Array.isArray(perms) ? perms : []);
  } catch (err) {
    // Supabase sin el script 03 todavía: se usan los permisos por defecto del cargo
    console.warn('Permisos: usando los valores por defecto del cargo', err);
    myPerms = new Set(PERM_FALLBACK[currentRole()] || []);
  }
  return myPerms;
}

/* Revisión silenciosa (cada 5 min, autoRefreshTick): si los permisos cambiaron mientras la página está
   abierta (otro Supervisor editó permisos, o una sección pasó al Laboratorio), se aplican sin recargar.
   Si la consulta falla NO se toca nada (a diferencia de permLoad, que cae a los valores por defecto). */
async function permRefreshQuiet() {
  let perms;
  try { perms = await sbRpc('app_my_permissions'); } catch { return; }
  if (!Array.isArray(perms)) return;
  const next = new Set(perms);
  if (next.size === myPerms.size && [...next].every(p => myPerms.has(p))) return;
  myPerms = next;
  renderSidebar();
  if (!canSeePage(currentPage)) {
    const first = firstAllowedPage();
    if (first) goToPage(first);
  } else if (currentPage === 'dashboard' && dashLoaded) {
    loadDashboard();   // los bloques del Inicio dependen de los permisos
  }
}

/* ¿La cuenta actual tiene este permiso? */
function can(perm) { return myPerms.has(perm); }

/* Permiso necesario para ver cada sección del menú */
const SECTION_PERM = {
  dashboard: 'view.dashboard', goodday: 'view.goodday', ops: 'view.ops', opstoday: 'view.opstoday',
  opslive: 'view.opslive', reportes: 'view.reportes', recalls: 'view.recalls', leads: 'view.leads', tl: 'view.tl',
  ventasfuera: 'view.ventasfuera',
  actualizacion: 'data.upload', accounts: 'accounts.manage', sidebarconfig: 'sidebar.manage',
  // Exclusivo de la cuenta Admin: no está en PERM_CATALOG (no se edita ni se asigna desde la página;
  // Supabase solo se lo da a la cuenta marcada como Admin — supabase/10_admin_y_seguimiento.sql)
  seguimiento: 'view.seguimiento',
};
function canSeePage(page) { const p = SECTION_PERM[page]; return !p || can(p); }

/* Primera sección permitida (para no dejar a nadie en una página que no puede ver) */
function firstAllowedPage() {
  return Object.keys(SECTION_PERM).find(canSeePage) || null;
}

function permLabel(key) { const p = PERM_CATALOG.find(x => x.key === key); return p ? p.label : key; }
function permIsSensitive(key) { return !!(PERM_CATALOG.find(x => x.key === key) || {}).sensitive; }
