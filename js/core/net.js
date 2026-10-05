/* Estado de la red, visible para todos:
   · Barra fina arriba mientras hay consultas en curso (Supabase / hojas de Google) — solo si tardan más
     de 300 ms, para que las rápidas no parpadeen. Los avisos de Seguimiento (keepalive) no cuentan.
   · Aviso "Sin conexión" cuando el navegador pierde internet (muy común en celular); al volver la
     conexión se actualiza sola la sección que se está viendo.
   Va PRIMERO en la lista de scripts: envuelve fetch antes de que nadie lo use. */

(function () {
  const realFetch = window.fetch.bind(window);
  let active = 0;
  let showTimer = null;

  function bar() { return document.getElementById('net-progress'); }
  function update() {
    const el = bar();
    if (!el) return;
    if (active > 0) {
      if (!showTimer && !el.classList.contains('on')) showTimer = setTimeout(() => { showTimer = null; if (active > 0) bar()?.classList.add('on'); }, 300);
    } else {
      clearTimeout(showTimer); showTimer = null;
      el.classList.remove('on');
    }
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const tracked = !(init && init.keepalive) && /supabase\.co|docs\.google\.com|googleusercontent\.com/.test(url);
    if (!tracked) return realFetch(input, init);
    active++;
    update();
    return realFetch(input, init).finally(() => { active = Math.max(0, active - 1); update(); });
  };
})();

function netRenderOffline() {
  const el = document.getElementById('net-offline');
  if (el) el.hidden = navigator.onLine !== false;
}

window.addEventListener('offline', netRenderOffline);
window.addEventListener('online', () => {
  netRenderOffline();
  // Volvió la conexión: la sección abierta se pone al día (mismo refresco silencioso de cada 5 min)
  if (typeof autoRefreshTick === 'function' && typeof getCurrentUser === 'function' && getCurrentUser()) autoRefreshTick();
});
document.addEventListener('DOMContentLoaded', netRenderOffline);

/* Botón "Reintentar" para los estados de error (code = lo que corre al hacer clic, ej. "loadGoodDay()") */
function uiRetryButton(code, label = 'Reintentar') {
  return `<button type="button" class="btn btn-ghost btn-sm net-retry" onclick="${code}">↻ ${label}</button>`;
}

/* Bloque "esqueleto" mientras carga: n filas grises animadas */
function uiSkeleton(n = 3, cls = '') {
  return `<div class="skel-list ${cls}" aria-busy="true" aria-label="Cargando">${'<span class="skel"></span>'.repeat(n)}</div>`;
}
