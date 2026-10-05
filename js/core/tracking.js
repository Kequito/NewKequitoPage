/* Registro de uso de la página (lo lee la sección Seguimiento — supabase/10_admin_y_seguimiento.sql).
   Corre para TODAS las cuentas mientras tienen la sesión abierta.

   Estados:
   · activo   → pestaña visible y con movimiento de mouse / teclado / clics / scroll en los últimos 2 min
   · inactivo → pestaña visible pero sin tocar nada hace más de 2 min
   · oculto   → página abierta pero minimizada o detrás de otra pestaña / programa
   (Página cerrada o PC apagada = no llega nada = "desconectado".)

   Cada minuto, y cada vez que cambia el estado o la sección, se avisa a Supabase (seg_ping).
   Supabase pone la hora y sabe quién es por la sesión: desde aquí solo se manda el estado, la sección
   y CUÁNTOS clics y teclas hubo (nunca qué se escribió). */

const SEG_IDLE_MS  = 2 * 60 * 1000;   // sin tocar nada este tiempo = inactivo
const SEG_PING_MS  = 60 * 1000;       // aviso periódico aunque nada cambie
const SEG_CHECK_MS = 10 * 1000;       // cada cuánto se revisa si cambió el estado

const segTab = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);   // id de esta pestaña
let segStarted = false;
let segDisabled = false;      // true si Supabase todavía no tiene el script 10 (deja de intentar)
let segState = null;          // último estado avisado
let segSection = null;        // última sección avisada
let segLastActivity = Date.now();
let segLastPing = 0;
let segClicks = 0;
let segKeys = 0;
let segQueue = Promise.resolve();   // los avisos salen en orden (cerrar el estado viejo antes de abrir el nuevo)

function segCurrentState() {
  if (document.hidden) return 'oculto';
  return Date.now() - segLastActivity > SEG_IDLE_MS ? 'inactivo' : 'activo';
}

/* keepalive: el aviso llega aunque se esté cerrando la pestaña */
function segSend(estado, seccion) {
  if (segDisabled || !getSessionToken()) return Promise.resolve();
  const body = JSON.stringify({ p_estado: estado, p_seccion: seccion || '', p_clics: segClicks, p_teclas: segKeys, p_pestana: segTab });
  segClicks = 0;
  segKeys = 0;
  segLastPing = Date.now();
  return fetch(`${SB_URL}/rest/v1/rpc/seg_ping`, {
    method: 'POST', keepalive: true,
    headers: { ...SB_HEADERS, 'Content-Type': 'application/json' },
    body,
  }).then(res => {
    if (res.status === 404) segDisabled = true;   // la función no existe todavía (falta el script 10)
  }).catch(() => { /* sin conexión: el siguiente aviso lo intenta de nuevo */ });
}

function segEnqueue(estado, seccion) {
  segQueue = segQueue.then(() => segSend(estado, seccion));
  return segQueue;
}

/* Revisa el estado: si cambió (o cambió de sección) cierra el tramo viejo y abre el nuevo */
function segTick() {
  if (!segStarted) return;
  const st = segCurrentState();
  const sec = typeof currentPage !== 'undefined' ? currentPage : '';
  if (st !== segState || sec !== segSection) {
    if (segState) segEnqueue(segState, segSection);   // alarga el tramo anterior hasta ahora
    segState = st;
    segSection = sec;
    segEnqueue(st, sec);
  } else if (Date.now() - segLastPing >= SEG_PING_MS) {
    segEnqueue(st, sec);
  }
}

function segOnActivity() {
  segLastActivity = Date.now();
  if (segState === 'inactivo') segTick();   // volvió a moverse: pasa a activo al instante
}

function segStart() {
  if (segStarted) return;
  segStarted = true;
  const opts = { passive: true, capture: true };
  ['mousemove', 'wheel', 'scroll', 'touchmove'].forEach(ev => document.addEventListener(ev, segOnActivity, opts));
  document.addEventListener('mousedown', () => { segClicks++; segOnActivity(); }, opts);
  document.addEventListener('touchstart', () => { segClicks++; segOnActivity(); }, opts);
  document.addEventListener('keydown', () => { segKeys++; segOnActivity(); }, opts);
  document.addEventListener('visibilitychange', segTick);
  window.addEventListener('pagehide', () => { if (segState) segSend(segState, segSection); });
  setInterval(segTick, SEG_CHECK_MS);
  segTick();
}
