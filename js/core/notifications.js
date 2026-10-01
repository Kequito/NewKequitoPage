/* Campanita de notificaciones del topbar — avisos REALES calculados desde Supabase:
   · Gestión de Recalls: órdenes reasignadas sin revisar (mismo criterio que "Ver TODAS las reasignadas").
   · Leads por Campaña: alertas del último guardado, de campaña Normal y de Post-Sale.
   · Equipos 360: OPs con alertas de calidad (core/errors.js), en un solo aviso resumen.
   Se actualiza al entrar, cada 5 min (autoRefreshTick) y después de acciones que cambian los avisos.
   El contador se apaga al abrir el panel y vuelve solo si aparece algo nuevo o distinto
   (lo visto se recuerda por navegador en localStorage). */

const NOTIF_SEEN_KEY = 'gc_notif_seen';
let notifItems = [];
let notifPending = null;   // actualización en curso: quien llame mientras tanto espera la MISMA (no se duplica)
let notifRecallsPending = null;   // último conteo de reasignadas sin revisar (lo muestra también el Inicio)

/* Recalls: por cada Id in CC vigente, su alerta MÁS RECIENTE decide si está pendiente */
async function notifCountPendingRecalls() {
  const [current, alerts] = await Promise.all([
    sbFetchAll('dt_recalls', 'select=id_in_cc&order=id_in_cc.asc'),
    sbFetchAll('dt_recalls_alerts', 'select=id,id_in_cc,reviewed&order=detected_at.desc,id.desc'),
  ]);
  const latest = new Map();
  alerts.forEach(a => { if (!latest.has(a.id_in_cc)) latest.set(a.id_in_cc, a); });
  return new Set(current.map(r => r.id_in_cc).filter(id => latest.has(id) && !latest.get(id).reviewed)).size;
}

async function notifFetchRecalls() {
  const n = await notifCountPendingRecalls();
  notifRecallsPending = n;
  if (n === 0) return [];
  return [{
    key: `recalls:${n}`,
    level: 'critical',
    title: n === 1 ? '1 orden reasignada sin revisar' : `${n} órdenes reasignadas sin revisar`,
    text: 'En Gestión de Recalls hay órdenes que cambiaron de operador y todavía nadie las marcó como revisadas.',
    actionLabel: 'Ver reasignadas',
    action: notifGoToRecalls,
  }];
}

/* Leads: reusa exactamente las mismas reglas del cuadro de alertas de la sección */
async function notifFetchLeads() {
  const row = await leadsFetchLatest();
  if (!row) return [];
  const items = [];
  [['normal', 'Campaña Normal'], ['postsale', 'Post-Sale']].forEach(([mode, label]) => {
    leadsComputeAlerts(row, mode).forEach(a => items.push({
      key: `leads:${mode}:${a.title}:${a.text}`,
      level: a.level,
      title: `${a.title} · ${label}`,
      text: a.text,
      when: row.created_at,
      actionLabel: 'Ver Leads',
      action: () => notifGoToLeads(mode),
    }));
  });
  return items;
}

/* Equipos 360: OPs de la distribución actual con alertas de calidad (errores repetidos o en aumento, 7 días) */
async function notifFetchQuality() {
  const [dis, errs] = await Promise.all([
    sbFetch('dt_dis', 'select=PEROP1AM'),
    errFetch(),
  ]);
  const byNum = errGroupByNum(errs.records || []);
  const nums = new Set((dis || []).map(d => sheetOperatorNumber(d.PEROP1AM)).filter(Boolean));
  let ops = 0, critical = false;
  nums.forEach(num => {
    const alerts = errComputeAlerts(byNum.get(num) || []);
    if (alerts.length) { ops++; if (alerts.some(a => a.level === 'critical')) critical = true; }
  });
  if (!ops) return [];
  return [{
    key: `quality:${ops}:${errs.records.length}`,
    level: critical ? 'critical' : 'warning',
    title: ops === 1 ? '1 OP con alerta de calidad' : `${ops} OPs con alertas de calidad`,
    text: 'Errores que se repiten o que aumentaron fuerte en los últimos 7 días (Gestión, Tipificación o Verificación).',
    actionLabel: 'Ver alertas',
    action: () => { goToPage('goodday'); },
  }];
}

function notifRefresh() {
  if (!getSessionToken()) return Promise.resolve();
  if (notifPending) return notifPending;
  notifPending = (async () => {
    // Solo avisos de secciones que esta cuenta puede ver. Si una fuente falla, las demás igual se muestran.
    const results = await Promise.allSettled([
      can('view.recalls') ? notifFetchRecalls() : Promise.resolve([]),
      can('view.leads') ? notifFetchLeads() : Promise.resolve([]),
      can('view.goodday') ? notifFetchQuality() : Promise.resolve([]),
    ]);
    results.forEach(r => { if (r.status === 'rejected') console.error('Error cargando avisos:', r.reason); });
    notifItems = results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
      .sort((a, b) => (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1));
    notifRenderBadge();
    if (notifIsOpen()) notifRenderPanel();
    // El Inicio muestra estos mismos avisos en "Requiere atención"
    if (typeof dashOnNotifUpdate === 'function') dashOnNotifUpdate();
  })().catch(err => console.error('Error actualizando avisos:', err))
      .finally(() => { notifPending = null; });
  return notifPending;
}

function notifSignature() { return notifItems.map(i => i.key).sort().join('|'); }

function notifGetSeen() {
  try { return localStorage.getItem(NOTIF_SEEN_KEY) || ''; } catch { return ''; }
}
function notifMarkSeen() {
  try { localStorage.setItem(NOTIF_SEEN_KEY, notifSignature()); } catch { /* sin storage: el contador simplemente no se recuerda */ }
}

function notifRenderBadge() {
  const badge = document.getElementById('notif-count');
  const btn = document.getElementById('notif-btn');
  const unseen = notifItems.length > 0 && notifSignature() !== notifGetSeen();
  badge.hidden = !unseen;
  badge.textContent = notifItems.length > 9 ? '9+' : String(notifItems.length);
  btn.setAttribute('aria-label', notifItems.length
    ? `Notificaciones: ${notifItems.length} aviso${notifItems.length === 1 ? '' : 's'}${unseen ? ' nuevo' + (notifItems.length === 1 ? '' : 's') : ''}`
    : 'Notificaciones: sin avisos');
}

function notifIsOpen() { return !document.getElementById('notif-panel').hidden; }

function notifRenderPanel() {
  const list = document.getElementById('notif-list');
  list.replaceChildren();
  if (notifItems.length === 0) {
    const empty = uiEl('div', 'notif-empty');
    empty.append(uiEl('div', 'notif-empty-icon', '✓'), uiEl('div', null, 'Todo en orden — sin avisos por ahora'));
    list.appendChild(empty);
    return;
  }
  notifItems.forEach(item => {
    const row = uiEl('div', `notif-item notif-item--${item.level === 'critical' ? 'critical' : 'warning'}`);
    const body = uiEl('div', 'notif-item-body');
    body.appendChild(uiEl('div', 'notif-item-title', item.title));
    body.appendChild(uiEl('div', 'notif-item-text', item.text));
    const foot = uiEl('div', 'notif-item-foot');
    if (item.when) foot.appendChild(uiEl('span', 'notif-item-when', `Datos de ${repTimeAgo(item.when)}`));
    const go = uiButton(`${item.actionLabel} →`, 'btn-ghost btn-sm', () => { notifClose(); item.action(); });
    foot.appendChild(go);
    body.appendChild(foot);
    row.append(uiEl('span', 'notif-item-dot'), body);
    list.appendChild(row);
  });
}

function notifToggle() { notifIsOpen() ? notifClose() : notifOpen(); }

function notifOpen() {
  notifRenderPanel();
  document.getElementById('notif-panel').hidden = false;
  document.getElementById('notif-btn').setAttribute('aria-expanded', 'true');
  notifMarkSeen();
  notifRenderBadge();
  notifRefresh(); // de paso trae lo más reciente
}

function notifClose() {
  document.getElementById('notif-panel').hidden = true;
  document.getElementById('notif-btn').setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', (e) => {
  if (!notifIsOpen()) return;
  if (!e.target.closest('#notif-panel') && !e.target.closest('#notif-btn')) notifClose();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && notifIsOpen()) notifClose(); });

/* ── Acciones de cada aviso ── */
function notifGoToRecalls() {
  // Abre directo la vista global de reasignadas pendientes (todos los turnos)
  recGlobalReassignedView = true;
  recOnlyReassigned = false;
  goToPage('recalls');
  if (recLoaded) applyRecFilters();
}

function notifGoToLeads(mode) {
  goToPage('leads');
  leadsSetCampaignMode(mode);
}
