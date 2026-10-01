/* Navegación entre vistas (setNav) y títulos del topbar. */

/* ══════════════════════════════
   NAVIGATION & ROUTING
══════════════════════════════ */
const viewMap = {
  'dashboard':     'view-dashboard',
  'goodday':       'view-goodday',
  'ops':           'view-ops',
  'opstoday':      'view-opstoday',
  'opslive':       'view-opslive',
  'reportes':      'view-reportes',
  'recalls':       'view-recalls',
  'leads':         'view-leads',
  'ventasfuera':   'view-ventasfuera',
  'tl':            'view-tl',
  'actualizacion': 'view-actualizacion',
  'accounts':      'view-accounts',
  'sidebarconfig': 'view-sidebarconfig',
  'seguimiento':   'view-seguimiento',   // la arma js/views/seguimiento.js (se descarga solo para Admin)
};
const titleMap = {
  'dashboard':     ['Inicio', 'Resumen general de la operación'],
  'goodday':       ['Equipos 360', 'Distribución, campañas, rendimiento y errores de cada OP y cada equipo'],
  'ops':           ['Approve Stats', 'Rendimiento de operadores por país'],
  'opstoday':      ['Stats OPs Today', 'Avance de operadores a lo largo de la jornada'],
  'opslive':       ['Stats OPs Live', 'Ventas y resultados en vivo de los OPs de la distribución — versión nueva en prueba'],
  'reportes':      ['Reporte', 'Generación y consulta de reportes'],
  'recalls':       ['Gestión de Recalls', 'Seguimiento de reasignación de órdenes'],
  'leads':         ['Leads por Campaña', 'OPs conectados y leads disponibles por cola'],
  'ventasfuera':   ['Ventas por Fuera', 'Ventas registradas por fuera, por operador y Team Leader — mes actual y anterior'],
  'tl':            ['Top Team Leader', 'Ranking y evolución de % Approve por Team Leader'],
  'actualizacion': ['Actualización de Data', 'Centraliza la carga de información de todas las secciones'],
  'accounts':      ['Gestión de Cuentas', 'Cuentas, contraseñas y permisos por cargo'],
  'sidebarconfig': ['Configurar Sidebar', 'Organización y colores de cada sección — solo Supervisores'],
  'seguimiento':   ['Seguimiento', 'Tiempo de uso y actividad de cada cuenta en la página'],
};

/* Secciones privadas de la cuenta Admin: su archivo JS se descarga SOLO cuando esa cuenta la abre
   (el permiso lo revisa Supabase; quien no lo tiene ni siquiera ve la sección en el menú). */
const ADMIN_VIEW_FILES = { seguimiento: 'views/seguimiento' };
const adminViewPending = {};
function adminLoadView(name) {
  if (!adminViewPending[name]) {
    adminViewPending[name] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `js/${ADMIN_VIEW_FILES[name]}.js?v=${encodeURIComponent(window.APP_VERSION || '')}`;
      s.onload = resolve;
      s.onerror = () => { adminViewPending[name] = null; s.remove(); reject(new Error('No se pudo cargar la sección. Revisa tu conexión e intenta de nuevo.')); };
      document.head.appendChild(s);
    });
  }
  return adminViewPending[name];
}

let currentPage = 'dashboard'; // usado por el auto-refresh para saber qué sección está viendo cada quien

/* Navegar a una sección desde código (avisos, botones "Ver detalle"), sin tener el elemento del menú a mano */
function goToPage(page) {
  const id = Object.keys(SIDEBAR_ITEMS).find(k => SIDEBAR_ITEMS[k].page === page);
  setNav(id ? document.getElementById(`nav-${id}`) : null, page);
}

function setNav(el, page) {
  // Sin permiso para esa sección (p. ej. desde un aviso o un botón "Ver detalle"): no se abre
  if (!canSeePage(page)) {
    uiAlert('Tu cuenta no tiene permiso para ver esta sección.', { title: 'Sin acceso', tone: 'warning' });
    return;
  }
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el) el.classList.add('active');
  // switch view
  Object.values(viewMap).forEach(v => {
    const el = document.getElementById(v);
    if (el) el.classList.remove('active');
  });
  const targetView = viewMap[page] || 'view-dashboard';
  const viewEl = document.getElementById(targetView);
  if (viewEl) viewEl.classList.add('active');
  // update topbar title
  const titles = titleMap[page] || titleMap['dashboard'];
  document.querySelector('.topbar-left h1').textContent = titles[0];
  document.getElementById('topbar-subtitle').textContent = titles[1] || '';
  // En celular el menú es un panel encima del contenido: al elegir una sección se cierra solo
  sidebarCloseMobile();
  // auto-load GoodDay on first visit
  if (page === 'goodday' && !gdLoaded) loadGoodDay();
  // auto-load OPs on first visit
  if (page === 'ops' && !opsLoaded) loadOps();
  // auto-load Stats OPs Today on first visit
  if (page === 'opstoday' && !otLoaded) loadOpsToday();
  // Stats OPs Live (nueva): lee la hoja de Google la primera vez que se abre
  if (page === 'opslive' && !olLoaded) olInitView();
  // auto-load Reportes history on first visit
  if (page === 'reportes' && !repLoaded) repInitView();
  // auto-load Recalls on first visit
  if (page === 'recalls' && !recLoaded) recInitView();
  // auto-load Leads por Campaña on first visit
  if (page === 'leads' && !leadsLoaded) leadsInitView();
  // Ventas por Fuera: lee las 4 hojas de Google la primera vez que se abre
  if (page === 'ventasfuera' && !vfLoaded) vfInitView();
  // auto-load Top Team Leader on first visit
  if (page === 'tl' && !tlLoaded) loadTlStats();
  // auto-load Inicio (normalmente ya se cargó en enterDashboard, esto es solo respaldo)
  if (page === 'dashboard' && !dashLoaded) loadDashboard();
  // auto-load Actualización de Data on first visit
  if (page === 'actualizacion' && !dataUpdateLoaded) loadDataUpdateView();
  // Gestión de Cuentas: cada visita pide reconfirmar contraseña (portón propio en la vista)
  if (page === 'accounts') loadAccountsView();
  // Configurar Sidebar: siempre se redibuja desde el último guardado, por si otro Supervisor cambió algo
  if (page === 'sidebarconfig') sidebarConfigInitView();
  // Seguimiento (Admin): se descarga su archivo la primera vez; cada visita vuelve a leer el día
  if (page === 'seguimiento') {
    adminLoadView('seguimiento').then(() => segOpenView())
      .catch(err => uiAlert(err.message, { title: 'Seguimiento', tone: 'danger' }));
  }
  // Registro de uso: avisa el cambio de sección
  if (typeof segTick === 'function') segTick();
}
