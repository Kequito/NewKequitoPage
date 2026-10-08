/* Auto-refresh silencioso de las vistas con data "en vivo". El intervalo se arranca en main.js.

   ══════════════════════════════
   AUTO-REFRESH — para que todos vean lo mismo sin recargar la página
   Cada 5 min se vuelve a pedir la sección que la persona está VIENDO y se redibuja en silencio
   (sin spinners ni parpadeos), conservando filtros, búsqueda y filas abiertas.
   Para no gastar de más:
   · Pestaña en segundo plano (minimizada / detrás de otra) = no se pide nada. Al volver a ella,
     si se saltó algún ciclo, se pone al día en ese momento.
   · Al volver a una sección ya abierta antes, si su data tiene más de 5 min, se refresca al entrar
     (antes se quedaba con lo de la primera visita hasta el siguiente ciclo).
   · Approve Stats y Top Team Leader solo cambian cuando alguien sube un Excel: primero se pregunta
     la "huella" (fecha de la última carga, 1 fila) y solo si cambió se vuelve a leer todo.
   · Se salta el ciclo si hay una subida de Excel en curso en esa sección (recBusy/otBusy).
══════════════════════════════ */
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

/* Cómo se refresca cada sección. ready = ya se cargó y no está ocupada. Las que no están aquí
   (Registro, Seguimiento, Cuentas, Configurar Sidebar, Actualización de Data) ya se vuelven a leer
   en cada visita, o solo las usan Supervisores para configurar. */
const AR_PAGES = {
  recalls:     { ready: () => recLoaded && !recBusy, run: () => { autoRefreshCloseTransientMenus(); return recLoadAll(true); } },
  opstoday:    { ready: () => otLoaded && !otBusy,   run: () => loadOpsToday(true) },
  leads:       { ready: () => leadsLoaded,           run: () => leadsLoadLatest(true) },
  opslive:     { ready: () => olLoaded,              run: () => olLoad(true) },
  reportes:    { ready: () => repLoaded,             run: () => repLoadCurrentReport(true) }, // las 4 fuentes (la 4 también desde Leads)
  goodday:     { ready: () => gdLoaded,              run: () => loadGoodDay(true) },          // asistencia y errores en vivo
  ventasfuera: { ready: () => vfLoaded,              run: () => vfLoad(true) },               // hojas en vivo
  ops:         { ready: () => opsLoaded,             run: () => opsRefreshIfChanged() },      // solo si hubo una carga nueva
  tl:          { ready: () => tlLoaded,              run: () => tlRefreshIfChanged() },       // solo si hubo carga, avance o baneo nuevo
  dashboard:   { ready: () => dashLoaded,            run: () => loadDashboard() },            // incluye la campanita
  seguimiento: { ready: () => typeof segRefresh === 'function', run: () => segRefresh() },
  registro:    { ready: () => regLoaded,             run: () => regLoad(true) },
};

const arRefreshedAt = {};   // sección → cuándo se cargó o refrescó por última vez
let arMissedTick = false;   // se saltó un ciclo con la pestaña en segundo plano

function autoRefreshCloseTransientMenus() {
  ['rec-copy-menu', 'rec-link-menu'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

async function autoRefreshTick() {
  if (document.hidden) { arMissedTick = true; return; }   // nadie la está mirando: no se gasta nada
  arMissedTick = false;
  try {
    await permRefreshQuiet();   // permisos al día (ej. una sección que pasó al Laboratorio deja de verse)
    const page = currentPage;
    const p = AR_PAGES[page];
    if (p && p.ready()) {
      arRefreshedAt[page] = Date.now();
      await p.run();
      if (page === 'dashboard') return;   // el Inicio ya actualizó la campanita
    }
    // La campanita se actualiza siempre, sin importar qué sección se está viendo
    await notifRefresh();
  } catch (err) {
    console.error('Error en auto-refresh:', err);
  }
}

/* Al entrar a una sección (setNav): la primera visita solo anota la hora (la carga la hace setNav);
   las siguientes la refrescan en silencio si su data tiene más de 5 min. */
function autoRefreshOnEnter(page) {
  const p = AR_PAGES[page];
  if (!p) return;
  if (!p.ready() || arRefreshedAt[page] === undefined) { arRefreshedAt[page] = Date.now(); return; }
  if (page === 'registro' || page === 'seguimiento') return;   // setNav ya las vuelve a leer en cada visita
  if (Date.now() - (arRefreshedAt[page] || 0) < AUTO_REFRESH_INTERVAL_MS) return;
  arRefreshedAt[page] = Date.now();
  Promise.resolve(p.run()).catch(err => console.error(`Error refrescando ${page}:`, err));
}

/* Volvió a la pestaña después de saltarse un ciclo: se pone al día ya, sin esperar los 5 min */
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && arMissedTick && typeof getCurrentUser === 'function' && getCurrentUser()) autoRefreshTick();
});

/* ── Huellas baratas: "¿cambió algo desde la última vez?" sin descargar toda la tabla ── */
const arSigs = {};

/* Anota la huella actual (al cargar la sección). Si falla, queda vacía y el próximo ciclo recarga una vez. */
async function arMarkSig(key, sigFn) {
  try { arSigs[key] = await sigFn(); } catch { arSigs[key] = null; }
}

/* true si la huella cambió desde la última vez (y la anota). Sin conexión = false (no se recarga nada). */
async function arSigChanged(key, sigFn) {
  let sig;
  try { sig = await sigFn(); } catch { return false; }
  const prev = arSigs[key];
  arSigs[key] = sig;
  return sig !== prev;
}

/* Fecha del último registro de una tabla (1 sola fila) */
async function arLatest(table, column) {
  const rows = await sbFetch(table, `select=${column}&order=${column}.desc.nullslast&limit=1`);
  return rows && rows[0] ? rows[0][column] : '';
}
