/* Auto-refresh silencioso de las vistas con data "en vivo". El intervalo se arranca en main.js. */

/* ══════════════════════════════
   AUTO-REFRESH — Recalls y Stats OPs Today
   Para que nadie quede viendo data vieja (alertas ya revisadas por otro TL, cargas
   nuevas de Excel) sin tener que recargar la página. Cada 5 min, SOLO si la persona
   está viendo esa sección en ese momento, se vuelve a pedir todo a Supabase y se
   redibuja en silencio (sin spinners ni parpadeos) preservando filtros, búsqueda y
   filas expandidas — esos ya viven en inputs/estado que el reload no toca.
   Se salta el ciclo si hay una subida de Excel en curso en esa sección (recBusy/otBusy),
   para no leer un estado a medio escribir mientras se borra e inserta.
══════════════════════════════ */
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos

function autoRefreshCloseTransientMenus() {
  ['rec-copy-menu', 'rec-link-menu'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

async function autoRefreshTick() {
  try {
    if (currentPage === 'recalls' && recLoaded && !recBusy) {
      autoRefreshCloseTransientMenus();
      await recLoadAll(true);
    } else if (currentPage === 'opstoday' && otLoaded && !otBusy) {
      await loadOpsToday(true);
    } else if (currentPage === 'leads' && leadsLoaded) {
      await leadsLoadLatest(true);
    } else if (currentPage === 'opslive' && olLoaded) {
      await olLoad(true);
    } else if (currentPage === 'reportes' && repLoaded) {
      await repLoadCurrentReport(true); // las 4 fuentes se actualizan por separado (y la 4 también desde Leads)
    } else if (currentPage === 'goodday' && gdLoaded) {
      await loadGoodDay(true);   // la asistencia es en vivo: se refresca igual que las demás
    }
    // La campanita se actualiza siempre, sin importar qué sección se está viendo
    await notifRefresh();
  } catch (err) {
    console.error('Error en auto-refresh:', err);
  }
}
