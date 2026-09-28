/* Arranque de la app. Va al final: cuando corre, todos los demás archivos ya están cargados. */

// Auto-refresh de Recalls / Stats OPs Today / Leads (ver core/autorefresh.js)
setInterval(autoRefreshTick, AUTO_REFRESH_INTERVAL_MS);

// Boot: carga los usuarios del login (o entra directo si ya hay sesión)
loadSessionUsers();
