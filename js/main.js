/* Arranque de la app. Va al final: cuando corre, todos los demás archivos ya están cargados. */

// Auto-refresh de Recalls / Stats OPs Today / Leads (ver core/autorefresh.js)
setInterval(autoRefreshTick, AUTO_REFRESH_INTERVAL_MS);

// Si la sesión vence (12 h) o Supabase la invalida con la página abierta, vuelve al login con aviso.
// También al volver a la pestaña: una pestaña en segundo plano puede pasar mucho sin revisar.
setInterval(checkSessionExpiry, 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSessionExpiry(); });

// Boot: carga los usuarios del login (o entra directo si ya hay sesión)
loadSessionUsers();
