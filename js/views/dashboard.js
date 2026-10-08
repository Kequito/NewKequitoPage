/* Vista Inicio — "centro de mando": en 5 segundos, cómo va la operación y qué hay que atender.

   · Bienvenida: saludo, fecha y estado general (los accesos a secciones ya están en el menú lateral).
   · Indicadores: Approve actual (Reporte), Leads disponibles, Asistencia de hoy, Recalls pendientes.
   · Bloques: Requiere atención · Approve por campaña · Top operadores · Top Team Leaders · Equipo hoy.

   Cada indicador y bloque se muestra SOLO si la cuenta puede ver la sección de donde sale su información
   (DASH_WIDGETS / DASH_KPIS). Los cálculos reusan los de cada sección (semáforo de Approve, reglas de
   Leads, ranking de Top TL, asistencia), así el Inicio nunca dice algo distinto a la sección.
   Se actualiza solo cada 5 min mientras se mira (autoRefreshTick), al volver la conexión y al cambiar permisos. */

let dashLoaded = false;
let dashBusy = false;
let dashFirstPaint = true;
let dashData = {};              // lo último cargado: { approve, leads, team, tl } (cada uno puede traer .error)
let dashApproveChartInstance = null;

/* Permiso de la sección de donde sale cada bloque (null = siempre, ver dashAttentionAllowed) */
const DASH_WIDGETS = {
  attention: null,
  approve: 'view.reportes',
  topops: 'view.ops',
  tl: 'view.tl',
  team: 'view.goodday',
};
/* Bloques que comparten fila: si uno no se ve, el otro ocupa todo el ancho */
const DASH_PAIRS = [['attention', 'approve'], ['topops', 'tl']];

function dashAttentionAllowed() {
  return ['view.recalls', 'view.leads', 'view.goodday', 'view.reportes'].some(can);
}
function dashWidgetAllowed(key) {
  return key === 'attention' ? dashAttentionAllowed() : can(DASH_WIDGETS[key]);
}

/* ══════════════════════════════
   CARGA
══════════════════════════════ */
/* force = botón "Actualizar": también vuelve a leer Approve Stats (pesado; solo cambia cuando se sube el Excel) */
async function loadDashboard(force = false) {
  dashLoaded = true;
  if (dashBusy) return;
  dashBusy = true;
  dashRenderHero();
  dashApplyVisibility();
  if (dashFirstPaint) dashRenderSkeletons();

  // Cada fuente se carga y se dibuja por su cuenta: si una falla, las demás igual se ven
  const job = (allowed, load, render) => allowed
    ? load().then(render).catch(err => { console.error('Inicio:', err); render({ error: err }); })
    : Promise.resolve();

  try {
    await Promise.all([
      job(can('view.reportes'), async () => {
        const [history, latestTwo] = await Promise.all([repFetchSnapshotsForRange('7d'), repFetchLatestTwo()]);
        return { history, latest: latestTwo[0] || null, prev: latestTwo[1] || null };
      }, d => { dashData.approve = d; dashRenderApprove(); }),

      job(can('view.leads'), async () => ({ row: await leadsFetchLatest() }),
        d => { dashData.leads = d; }),

      job(can('view.goodday'), async () => {
        const [dis, att] = await Promise.all([
          sbFetchAll('dt_dis', 'select=PEROP1AM,TEAMLEADER,PAIS,EMPRESA,HORARIO,DESCANSO&order=PEROP1AM.asc'),
          attFetch().catch(err => ({ error: err })),
        ]);
        return { dis, att };
      }, d => { dashData.team = d; dashRenderTeam(); }),

      job(can('view.tl'), async () => {
        const [raw, banned] = await Promise.all([sbFetchAll('dt_tl_stats', `select=*&order=${encodeURIComponent('"Team Leader"')}.asc`), tlFetchBanned()]);
        return { raw, banned };
      }, d => { dashData.tl = d; dashRenderTL(); if (dashPos) dashRenderPosition(); }),

      // Approve Stats es pesado: en el refresco automático solo se relee si hubo una carga nueva (huella barata)
      job(can('view.ops'), async () => { if (force || !opsLoaded) await loadOps(); else await opsRefreshIfChanged(); return {}; },
        d => { dashRenderTopOps(d); }),

      notifRefresh(),   // avisos de Recalls / Leads / calidad (los mismos de la campanita)

      dashLoadExt(),    // tarjeta de la extensión de órdenes (link de Drive)

      // Tu posición (solo si la cuenta es Team Leader en la distribución)
      dashLoadPosition().then(p => { dashPos = p; }).catch(err => { console.error('Inicio · Tu posición:', err); dashPos = { error: err }; })
        .then(() => dashRenderPosition()),
    ]);
  } finally {
    dashFirstPaint = false;
    dashRenderKPIs();
    dashRenderAttention();
    dashRenderPosition();   // con todo cargado (el desempate de calidad usa Approve Stats)
    dashBusy = false;
  }
}

/* La campanita se actualizó por su cuenta (cada 5 min o tras una acción): refrescar lo que depende de ella */
function dashOnNotifUpdate() {
  if (!dashLoaded || dashBusy) return;
  dashRenderKPIs();
  dashRenderAttention();
}

function dashApplyVisibility() {
  const visible = {};
  Object.keys(DASH_WIDGETS).forEach(key => {
    visible[key] = dashWidgetAllowed(key);
    const el = document.getElementById(`dash-w-${key}`);
    el.hidden = !visible[key];
    el.classList.remove('dash-w--full');
  });
  DASH_PAIRS.forEach(([a, b]) => {
    if (visible[a] && !visible[b]) document.getElementById(`dash-w-${a}`).classList.add('dash-w--full');
    if (visible[b] && !visible[a]) document.getElementById(`dash-w-${b}`).classList.add('dash-w--full');
  });
  const any = Object.values(visible).some(Boolean) || DASH_KPIS.some(k => can(k.perm));
  document.getElementById('dash-nothing').hidden = any;
}

function dashRenderSkeletons() {
  const sk = n => Array.from({ length: n }, () => '<div class="skel skel-line"></div>').join('');
  document.getElementById('dash-kpis').innerHTML = DASH_KPIS.filter(k => can(k.perm))
    .map(() => '<div class="dash-kpi"><div class="skel skel-line short"></div><div class="skel skel-big"></div><div class="skel skel-line"></div></div>').join('');
  ['dash-attention-list', 'dash-approve-bars', 'dash-topops-body', 'dash-tl-body', 'dash-team-body']
    .forEach(id => { document.getElementById(id).innerHTML = `<div class="dash-skel-wrap">${sk(4)}</div>`; });
}

function dashErrorHTML(what) {
  return `<div class="dash-error">⚠ No se pudo cargar ${what}. Se reintenta solo en unos minutos. ${uiRetryButton('loadDashboard()')}</div>`;
}

/* ══════════════════════════════
   BIENVENIDA
══════════════════════════════ */
function dashFirstName(full) {
  const w = String(full || '').trim().split(/\s+/)[0] || '';
  return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '';
}

function dashRenderHero() {
  const user = getCurrentUser();
  const h = new Date().getHours();
  const hello = h < 12 ? 'Buenos días' : h < 19 ? 'Buenas tardes' : 'Buenas noches';
  const name = dashFirstName(user && user[0]);
  document.getElementById('dash-hello').textContent = `${hello}${name ? `, ${name}` : ''} 👋`;
  const date = new Date().toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('dash-date').textContent = `${date.charAt(0).toUpperCase()}${date.slice(1)}${user && user[2] ? ` · ${user[2]}` : ''}`;
}

/* ══════════════════════════════
   EXTENSIÓN DE ÓRDENES — tarjeta con el link a la carpeta de Drive (todavía no está en la Chrome Web Store).
   El link vive en dt_data_links (clave ext_ordenes): lo lee cualquier sesión y solo lo cambia quien tiene
   "datalinks.edit" (Supervisor; Supabase vuelve a revisarlo). No se muestra a las cuentas de Operador.
══════════════════════════════ */
const DASH_EXT_KEY = 'ext_ordenes';
const DASH_EXT_COUNTRIES = [['Uruguay', 'UY'], ['Paraguay', 'PY'], ['Peru', 'PE'], ['Mexico', 'MX']];   // donde se crean órdenes
let dashExtLink = null;   // { url, updated_at, updated_by } o null si nadie lo configuró

async function dashLoadExt() {
  if (currentRole() === 'operador') { document.getElementById('dash-ext').hidden = true; return; }
  try {
    const rows = await sbFetch('dt_data_links', `select=*&section_key=eq.${DASH_EXT_KEY}`);
    dashExtLink = (rows && rows[0]) || null;
  } catch (err) {
    console.warn('Inicio · link de la extensión no disponible:', err);   // se queda con el último que se leyó
  }
  dashRenderExt();
}

function dashRenderExt() {
  const box = document.getElementById('dash-ext');
  const url = dashExtLink && dashExtLink.url;
  const edit = can('datalinks.edit');
  const flags = DASH_EXT_COUNTRIES.map(([c, code]) => `<span class="dash-ext-flag" title="${c}">${countryFlag(c)}<b>${code}</b></span>`).join('');
  box.hidden = false;
  box.innerHTML = `
    <div class="dash-ext-top">
      <span class="dash-ext-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg></span>
      <div class="dash-ext-id">
        <div class="dash-ext-title">Extensión de órdenes</div>
        <div class="dash-ext-sub">Para Chrome · crea órdenes más rápido</div>
      </div>
      ${edit ? `<button type="button" class="dash-ext-edit" onclick="dashExtEdit()" title="${url ? 'Cambiar el link de Drive' : 'Agregar el link de Drive'}" aria-label="Editar link">✎</button>` : ''}
    </div>
    <div class="dash-ext-flags">${flags}</div>
    ${url
      ? `<a class="dash-ext-btn" href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener">Descargar desde Drive <span aria-hidden="true">↗</span></a>`
      : edit
        ? '<button type="button" class="dash-ext-btn is-empty" onclick="dashExtEdit()">+ Agregar link de Drive</button>'
        : '<span class="dash-ext-btn is-off">Link disponible pronto</span>'}
    <button type="button" class="dash-ext-help" onclick="dashExtHowTo()">¿Cómo instalarla?</button>`;
}

/* Solo Supervisor (datalinks.edit): mismo diálogo de los links de Actualización de Data */
async function dashExtEdit() {
  if (!can('datalinks.edit')) return;
  if (dashExtLink) dataLinksMap[DASH_EXT_KEY] = dashExtLink;   // para que el diálogo muestre el link actual
  await dataLinkEdit(DASH_EXT_KEY, 'Extensión de órdenes (carpeta de Drive)');
  if (dataLinksMap[DASH_EXT_KEY]) dashExtLink = dataLinksMap[DASH_EXT_KEY];
  dashRenderExt();
}

/* Pasos para instalarla sin la Chrome Web Store (modo desarrollador) */
function dashExtHowTo() {
  const body = uiEl('ol', 'dash-ext-steps');
  [
    'Abre el link y descarga la carpeta de la extensión. Si llega como .zip, descomprímela.',
    'En Chrome, escribe chrome://extensions en la barra de direcciones.',
    'Activa el "Modo de desarrollador" (arriba a la derecha).',
    'Pulsa "Cargar extensión sin empaquetar" y elige la carpeta descomprimida.',
    'Fíjala con el ícono del rompecabezas 🧩 para tenerla siempre a mano.',
  ].forEach(t => body.appendChild(uiEl('li', null, t)));
  uiDialog({ title: '🧩 Instalar la extensión de órdenes', body, confirmText: 'Entendido', cancelText: null });
}

/* Estado general, a partir de los avisos de "Requiere atención" */
function dashRenderStatus(items) {
  const el = document.getElementById('dash-status');
  const crit = items.filter(i => i.level === 'critical').length;
  const warn = items.length - crit;
  if (!dashAttentionAllowed()) { el.innerHTML = ''; return; }
  if (!items.length) {
    el.className = 'dash-status dash-status--ok';
    el.innerHTML = '🟢 Todo en orden por ahora';
    return;
  }
  el.className = `dash-status dash-status--${crit ? 'critical' : 'warning'}`;
  const parts = [];
  if (crit) parts.push(`${crit} urgente${crit === 1 ? '' : 's'}`);
  if (warn) parts.push(`${warn} para revisar`);
  el.innerHTML = `${crit ? '🔴' : '🟡'} <button type="button" class="dash-status-link" onclick="dashScrollTo('dash-w-attention')">${items.length} ${items.length === 1 ? 'cosa requiere' : 'cosas requieren'} atención</button> <span class="dash-status-detail">(${parts.join(' · ')})</span>`;
}

function dashScrollTo(id) {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ══════════════════════════════
   INDICADORES CLAVE
══════════════════════════════ */
const DASH_KPIS = [
  { key: 'approve', perm: 'view.reportes', page: 'reportes', build: () => dashKpiApprove() },
  { key: 'leads',   perm: 'view.leads',    page: 'leads',    build: () => dashKpiLeads() },
  { key: 'att',     perm: 'view.goodday',  page: 'goodday',  build: () => dashKpiAttendance() },
  { key: 'recalls', perm: 'view.recalls',  page: 'recalls',  build: () => dashKpiRecalls() },
];

function dashRenderKPIs() {
  const el = document.getElementById('dash-kpis');
  const list = DASH_KPIS.filter(k => can(k.perm));
  el.hidden = list.length === 0;
  el.style.setProperty('--n', list.length);
  el.innerHTML = list.map(k => {
    let d;
    try { d = k.build(); } catch (err) { console.error('Inicio KPI', k.key, err); d = { label: k.key, value: '—', sub: 'no disponible' }; }
    return `<button type="button" class="dash-kpi dash-kpi--${d.tone || 'neutral'}" onclick="goToPage('${k.page}')" title="Ir a la sección">
      <span class="dash-kpi-head"><span class="dash-kpi-icon">${d.icon || ''}</span><span class="dash-kpi-label">${d.label}</span></span>
      <span class="dash-kpi-row"><span class="dash-kpi-value">${d.value}</span>${d.spark || ''}</span>
      <span class="dash-kpi-sub">${d.sub || ''}</span>
    </button>`;
  }).join('');
}

/* Minigráfica de línea (Approve de los últimos días) */
function dashSparkSVG(values, w = 96, h = 32) {
  const v = values.filter(n => Number.isFinite(n));
  if (v.length < 2) return '';
  const min = Math.min(...v), max = Math.max(...v), span = max - min || 1;
  const pts = v.map((n, i) => [2 + (i / (v.length - 1)) * (w - 6), h - 3 - ((n - min) / span) * (h - 6)]);
  const last = pts[pts.length - 1];
  return `<svg class="dash-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline points="${pts.map(p => p.map(x => x.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3" fill="currentColor"/></svg>`;
}

function dashKpiApprove() {
  const a = dashData.approve;
  const base = { icon: '📈', label: 'Approve actual' };
  if (!a || a.error) return { ...base, value: '—', sub: a && a.error ? 'no se pudo cargar' : 'cargando…' };
  if (!a.latest) return { ...base, value: '—', sub: 'todavía no hay reportes guardados' };
  const pct = a.latest.global.approvePct;
  const delta = a.prev ? pct - a.prev.global.approvePct : null;
  const perDay = dashLastSnapshotPerDay(a.history).map(h => h.global && h.global.approvePct);
  const cls = repApproveClass(pct);
  return {
    ...base,
    tone: cls === 'rep-approve-good' ? 'good' : cls === 'rep-approve-bad' ? 'bad' : 'neutral',
    value: repFmtPct(pct),
    spark: dashSparkSVG(perDay),
    sub: `${repDeltaHTML(delta)} reporte ${repTimeAgo(a.latest.created_at)}`,
  };
}

/* Campañas Normales del último pegado, con la cobertura y las alertas que usa Leads por Campaña */
function dashLeadsModel(row) {
  return ((row && row.by_country) || []).map(c => ({
    country: c.country, cov: repCoverageFor(c), issues: leadsCountryIssues(c),
  }));
}

function dashKpiLeads() {
  const l = dashData.leads;
  const base = { icon: '📞', label: 'Leads disponibles' };
  if (!l || l.error) return { ...base, value: '—', sub: l && l.error ? 'no se pudo cargar' : 'cargando…' };
  if (!l.row) return { ...base, value: '—', sub: 'todavía no se pegó data' };
  const model = dashLeadsModel(l.row);
  const available = model.reduce((s, m) => s + m.cov.available, 0);
  const red = model.filter(m => m.issues.some(i => i.level === 'critical')).length;
  const staleMin = (Date.now() - new Date(l.row.created_at).getTime()) / 60000;
  const stale = staleMin >= LEADS_STALE_BAD_MIN;
  return {
    ...base,
    tone: red ? 'bad' : stale ? 'warn' : 'good',
    value: available.toLocaleString('es-PE'),
    sub: `${red ? `🔴 ${red} campaña${red === 1 ? '' : 's'} en rojo` : '✓ todas con leads'} · <span class="${stale ? 'dash-stale' : ''}">data ${repTimeAgo(l.row.created_at)}</span>`,
  };
}

/* OPs de la distribución (sin repetir el mismo número de operador) con su código de asistencia */
function dashTeamOps() {
  const t = dashData.team;
  if (!t || t.error) return null;
  const attMap = t.att && t.att.map;
  const seen = new Set();
  const ops = [];
  (t.dis || []).forEach(d => {
    const num = sheetOperatorNumber(d.PEROP1AM);
    const key = num || (d.PEROP1AM || '').trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    ops.push({
      pais: (d.PAIS || '').trim() || 'Sin campaña', empresa: (d.EMPRESA || '').trim(), horario: (d.HORARIO || '').trim(),
      descanso: (d.DESCANSO || '').trim(), att: attMap && num ? String(attMap.get(num) || '').trim().toUpperCase() : null,
    });
  });
  return { ops, attOk: !!attMap };
}

/* Grupos de asistencia (códigos de core/attendance.js) */
const DASH_ATT_GROUPS = [
  { key: 'present', label: 'Asistieron', codes: ['A'], cls: 'att-g-present' },
  { key: 'absent',  label: 'Faltas / suspensión', codes: ['FA', 'S'], cls: 'att-g-absent' },
  { key: 'rest',    label: 'Descanso / vacaciones', codes: ['OFF', 'VA', 'DM'], cls: 'att-g-rest' },
  { key: 'gone',    label: 'Baja', codes: ['B'], cls: 'att-g-gone' },
  { key: 'other',   label: 'Otro código', codes: null, cls: 'att-g-other' },
  { key: 'empty',   label: 'Sin marcar', codes: [''], cls: 'att-g-empty' },
];
function dashAttGroup(code) {
  const c = code || '';
  return DASH_ATT_GROUPS.find(g => g.codes && g.codes.includes(c)) || DASH_ATT_GROUPS.find(g => g.key === 'other');
}
function dashAttCounts(ops) {
  const counts = {};
  DASH_ATT_GROUPS.forEach(g => { counts[g.key] = 0; });
  ops.forEach(o => { counts[dashAttGroup(o.att).key]++; });
  return counts;
}

function dashKpiAttendance() {
  const base = { icon: '🧑‍💻', label: 'Asistencia hoy' };
  const t = dashData.team;
  if (!t || t.error) return { ...base, value: '—', sub: t && t.error ? 'no se pudo cargar' : 'cargando…' };
  const team = dashTeamOps();
  if (!team.attOk) return { ...base, value: `${team.ops.length}`, sub: 'OPs en distribución · asistencia no disponible' };
  const c = dashAttCounts(team.ops);
  // Base del %: los que deberían trabajar hoy (sin descansos ni bajas)
  const expected = team.ops.length - c.rest - c.gone;
  const pct = expected > 0 ? Math.round((c.present / expected) * 100) : 0;
  return {
    ...base,
    tone: c.absent > 0 || pct < 85 ? (pct < 75 ? 'bad' : 'warn') : 'good',
    value: `${c.present}<span class="dash-kpi-of">/${expected}</span>`,
    sub: `${pct}% · ${c.absent} falta${c.absent === 1 ? '' : 's'} · ${c.empty} sin marcar`,
  };
}

function dashKpiRecalls() {
  const base = { icon: '🔁', label: 'Recalls pendientes' };
  const n = notifRecallsPending;
  if (n === null || n === undefined) return { ...base, value: '—', sub: 'cargando…' };
  return {
    ...base,
    tone: n > 0 ? 'bad' : 'good',
    value: n.toLocaleString('es-PE'),
    sub: n > 0 ? `${n === 1 ? 'orden reasignada' : 'órdenes reasignadas'} sin revisar` : '✓ todas revisadas',
  };
}

/* ══════════════════════════════
   REQUIERE ATENCIÓN — avisos de la campanita + los propios del Inicio
══════════════════════════════ */
let dashAttentionItems = [];

function dashExtraAlerts() {
  const extra = [];
  const a = dashData.approve;
  if (can('view.reportes') && a && a.latest) {
    const low = (a.latest.by_country || []).filter(c => c.total > 0 && repApproveClass(c.approvePct) === 'rep-approve-bad')
      .sort((x, y) => x.approvePct - y.approvePct);
    if (low.length) {
      extra.push({
        level: 'warning',
        title: low.length === 1 ? `Approve bajo en ${low[0].country}` : `Approve bajo en ${low.length} campañas`,
        text: `${low.map(c => `${c.country} ${repFmtPct(c.approvePct)}`).join(' · ')} — por debajo de 25% en el último reporte.`,
        actionLabel: 'Ver Reporte', action: () => goToPage('reportes'),
      });
    }
  }
  const l = dashData.leads;
  if (can('view.leads') && l && l.row) {
    const min = Math.round((Date.now() - new Date(l.row.created_at).getTime()) / 60000);
    if (min >= LEADS_STALE_BAD_MIN) {
      extra.push({
        level: 'warning', title: 'La data de Leads está vieja',
        text: `Se pegó ${repTimeAgo(l.row.created_at)}. Conviene actualizarla para no decidir con números viejos.`,
        actionLabel: 'Actualizar Leads', action: () => goToPage('leads'),
      });
    }
  }
  return extra;
}

function dashRenderAttention() {
  const list = document.getElementById('dash-attention-list');
  dashAttentionItems = [...notifItems, ...dashExtraAlerts()]
    .sort((a, b) => (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1));
  dashRenderStatus(dashAttentionItems);
  document.getElementById('dash-attention-count').textContent = dashAttentionItems.length ? `(${dashAttentionItems.length})` : '';
  if (!dashAttentionItems.length) {
    list.innerHTML = `<div class="dash-all-ok"><span>✓</span><div><strong>Todo en orden</strong><small>No hay nada urgente en las secciones que ves. Se revisa solo cada 5 minutos.</small></div></div>`;
    return;
  }
  list.innerHTML = dashAttentionItems.map((it, i) => `
    <div class="dash-alert dash-alert--${it.level === 'critical' ? 'critical' : 'warning'}">
      <span class="dash-alert-dot"></span>
      <div class="dash-alert-body">
        <div class="dash-alert-title">${escapeHtml(it.title)}</div>
        <div class="dash-alert-text">${escapeHtml(it.text)}</div>
      </div>
      ${it.action ? `<button type="button" class="btn btn-ghost btn-sm" onclick="dashAttentionGo(${i})">${escapeHtml(it.actionLabel || 'Ver')} →</button>` : ''}
    </div>`).join('');
}

function dashAttentionGo(i) {
  const it = dashAttentionItems[i];
  if (it && typeof it.action === 'function') it.action();
}

/* ══════════════════════════════
   APPROVE POR CAMPAÑA (+ evolución 7 días)
══════════════════════════════ */
function dashRenderApprove() {
  const a = dashData.approve;
  const bars = document.getElementById('dash-approve-bars');
  const meta = document.getElementById('dash-approve-meta');
  if (a.error) { bars.innerHTML = dashErrorHTML('el Approve'); meta.innerHTML = ''; return; }
  dashRenderApproveChart(dashLastSnapshotPerDay(a.history));
  if (!a.latest) {
    meta.innerHTML = '';
    bars.innerHTML = '<div class="dash-empty">Todavía no hay reportes guardados.</div>';
    return;
  }
  const g = a.latest.global;
  const delta = a.prev ? g.approvePct - a.prev.global.approvePct : null;
  meta.innerHTML = `<span class="dash-approve-global"><span class="rep-approve-badge ${repApproveClass(g.approvePct)}">${repFmtPct(g.approvePct)}</span> global ${repDeltaHTML(delta)}</span>
    <span class="muted-11">Reporte ${repTimeAgo(a.latest.created_at)}${a.latest.created_by ? ` · ${escapeHtml(a.latest.created_by)}` : ''} · ${g.total.toLocaleString('es-PE')} leads</span>`;

  // Cambio por campaña: solo contra la actualización anterior del MISMO día (igual que la tabla del Reporte)
  const samePrev = a.prev && repSameDay(a.latest.created_at, a.prev.created_at) ? a.prev : null;
  const rows = (a.latest.by_country || []).filter(c => c.total > 0).sort((x, y) => y.approvePct - x.approvePct);
  const axis = Math.max(40, Math.ceil((Math.max(0, ...rows.map(r => r.approvePct)) + 5) / 5) * 5);
  bars.innerHTML = rows.map(c => {
    const p = samePrev && (samePrev.by_country || []).find(x => x.country === c.country);
    const cls = repApproveClass(c.approvePct);
    return `<div class="dash-bar-row">
      <span class="dash-bar-name">${countryFlag(c.country)}${escapeHtml(c.country)}</span>
      <span class="dash-bar-track"><i class="${cls}" style="width:${Math.min(100, (c.approvePct / axis) * 100).toFixed(1)}%"></i><b class="dash-bar-goal" style="left:${((30 / axis) * 100).toFixed(1)}%" title="30%: verde desde aquí"></b></span>
      <span class="dash-bar-val ${cls}">${repFmtPct(c.approvePct)}</span>
      <span class="dash-bar-delta">${p ? repDeltaHTML(c.approvePct - p.approvePct) : ''}</span>
    </div>`;
  }).join('') || '<div class="dash-empty">El último reporte no tiene campañas con leads.</div>';
}

/* Agrupa por día calendario local y se queda solo con el snapshot más reciente de cada día.
   (La usa también Top Team Leader para su gráfica.) */
function dashLastSnapshotPerDay(history) {
  const byDay = {};
  (history || []).forEach(h => {
    const d = new Date(h.created_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!byDay[key] || new Date(h.created_at) > new Date(byDay[key].created_at)) byDay[key] = h;
  });
  return Object.keys(byDay).sort().map(k => byDay[k]);
}

function dashRenderApproveChart(perDay) {
  const canvas = document.getElementById('dashApproveChart');
  if (dashApproveChartInstance) { dashApproveChartInstance.destroy(); dashApproveChartInstance = null; }
  const box = document.getElementById('dash-approve-chart-box');
  if (!perDay || perDay.length === 0) { box.hidden = true; return; }
  box.hidden = false;

  const labels = perDay.map(h => {
    const d = new Date(h.created_at);
    const day = d.toLocaleDateString('es-ES', { weekday: 'short' }).replace('.', '');
    return `${day.charAt(0).toUpperCase()}${day.slice(1)} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
  });
  const values = perDay.map(h => (h.global && h.global.approvePct !== undefined) ? Number(h.global.approvePct.toFixed(1)) : null);
  const seen = values.filter(v => v !== null);
  // Eje ajustado a los datos (mínimo 40%): en un gráfico chico, con tope 75% las barras quedaban aplastadas
  const axisMax = Math.min(100, Math.max(40, Math.ceil(((seen.length ? Math.max(...seen) : 0) + 5) / 5) * 5));

  dashApproveChartInstance = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Approve % del día', data: values, backgroundColor: values.map(repBarColor), borderRadius: 4, borderSkipped: false }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        datalabels: {
          display: true, formatter: v => (v !== null && v !== undefined ? `${v}%` : ''),
          color: '#fff', textStrokeColor: 'rgba(0,0,0,.55)', textStrokeWidth: 3,
          font: { family: "'Lexend', sans-serif", weight: '700', size: 11 }, anchor: 'center', align: 'center',
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { ...chartDefaults.font, maxRotation: 0, autoSkip: true, maxTicksLimit: 7 } },
        y: { grid: { color: CHART_GRID }, ticks: { ...chartDefaults.font, callback: v => v + '%' }, min: 0, max: axisMax },
      },
    },
  });
}

/* ══════════════════════════════
   TOP OPERADORES — pestañas por campaña; rota sola hasta que alguien elige una
══════════════════════════════ */
const DASH_TOP_OPS_N = 6;
const DASH_TOP_OPS_INTERVAL = 8000;
let dashTopOpsCountries = [];
let dashTopOpsIndex = 0;
let dashTopOpsTimer = null;
let dashTopOpsManual = false;   // true cuando la persona eligió una pestaña: deja de rotar

function dashRenderTopOps(d) {
  const body = document.getElementById('dash-topops-body');
  if (d && d.error) { body.innerHTML = dashErrorHTML('Approve Stats'); return; }
  dashTopOpsCountries = OPS_STATS_COUNTRIES
    .map(c => ({ country: c, rows: opsGetCountryRows(c).slice(0, DASH_TOP_OPS_N) }))
    .filter(x => x.rows.length > 0);
  if (dashTopOpsIndex >= dashTopOpsCountries.length) dashTopOpsIndex = 0;
  if (!dashTopOpsCountries.length) {
    document.getElementById('dash-topops-tabs').innerHTML = '';
    body.innerHTML = '<div class="dash-empty">Sin datos de Approve Stats todavía — se suben desde Actualización de Data.</div>';
    dashResetTopOpsTimer();
    return;
  }
  dashRenderTopOpsSlide();
  dashResetTopOpsTimer();
}

function dashRenderTopOpsSlide() {
  const slide = dashTopOpsCountries[dashTopOpsIndex];
  if (!slide) return;
  document.getElementById('dash-topops-tabs').innerHTML = dashTopOpsCountries.map((s, i) => {
    const color = REP_COUNTRY_COLORS[s.country] || REP_FALLBACK_COLORS[i % REP_FALLBACK_COLORS.length];
    const on = i === dashTopOpsIndex;
    return `<button type="button" class="dash-tab ${on ? 'on' : ''}" role="tab" aria-selected="${on}" style="--c:${color}" onclick="dashTopOpsPick(${i})">${countryFlag(s.country)}${escapeHtml(s.country)}</button>`;
  }).join('');
  const medal = i => (i < 3 ? TL_MEDALS[i] : `<span class="dash-rank-n">${i + 1}</span>`);
  document.getElementById('dash-topops-body').innerHTML = `<div class="tbl-wrap"><table class="dash-table">
    <thead><tr><th></th><th>Operador</th><th>Team Leader</th><th class="num">Órdenes</th><th class="num">Approve %</th></tr></thead>
    <tbody>${slide.rows.map((r, i) => `<tr>
      <td class="dash-medal">${medal(i)}</td>
      <td><div class="dash-op-name">${escapeHtml(r.asesor)}</div><div class="dash-op-code">${escapeHtml(r.operator)} · ${escapeHtml(r.horario)}</div></td>
      <td>${recTlBadge(r.teamLeader)}</td>
      <td class="num">${r.total.toLocaleString('es-PE')}</td>
      <td class="num">${r.approvePct !== null ? `<span class="rep-approve-badge ${repApproveClass(r.approvePct)}">${r.approvePct.toFixed(1)}%</span>` : '—'}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function dashTopOpsPick(i) {
  dashTopOpsManual = true;   // eligió una: se queda ahí
  dashTopOpsIndex = i;
  dashRenderTopOpsSlide();
  dashResetTopOpsTimer();
}

function dashResetTopOpsTimer() {
  if (dashTopOpsTimer) { clearInterval(dashTopOpsTimer); dashTopOpsTimer = null; }
  const track = document.getElementById('dash-topops-progress');
  const fill = document.getElementById('dash-topops-progress-fill');
  const rotate = !dashTopOpsManual && dashTopOpsCountries.length > 1;
  track.hidden = !rotate;
  if (!rotate) return;
  const restart = () => {
    fill.style.transition = 'none';
    fill.style.width = '0%';
    void fill.offsetWidth;   // fuerza reflow para que la transición arranque de cero
    fill.style.transition = `width ${DASH_TOP_OPS_INTERVAL}ms linear`;
    fill.style.width = '100%';
  };
  restart();
  dashTopOpsTimer = setInterval(() => {
    if (currentPage !== 'dashboard') return;   // no gasta nada si no se está mirando
    dashTopOpsIndex = (dashTopOpsIndex + 1) % dashTopOpsCountries.length;
    dashRenderTopOpsSlide();
    restart();
  }, DASH_TOP_OPS_INTERVAL);
}

/* "Ver campaña →": abre Approve Stats directo en la campaña que se está viendo */
function dashGoToOpsCountry() {
  const slide = dashTopOpsCountries[dashTopOpsIndex];
  goToPage('ops');
  if (slide) (async () => { if (!opsLoaded) await loadOps(); opsShowCountryDetail(slide.country); })();
}

/* ══════════════════════════════
   TOP TEAM LEADERS — top 5 (sin baneados) y "tú", con las mismas reglas de Top Team Leader
══════════════════════════════ */
const DASH_TL_N = 5;

function dashRenderTL() {
  const body = document.getElementById('dash-tl-body');
  const t = dashData.tl;
  if (t.error) { body.innerHTML = dashErrorHTML('el ranking de Team Leaders'); return; }
  const banned = new Set((t.banned || []).map(b => b.team_leader));
  const rows = tlComputeRanking(t.raw).filter(r => !banned.has(r.teamLeader));
  if (!rows.length) { body.innerHTML = '<div class="dash-empty">Todavía no hay data de Team Leaders.</div>'; return; }
  const minUO = Math.round(tlMedian(rows.map(r => r.uniqueOrders)) * TL_LOW_VOLUME_RATIO);
  rows.forEach((r, i) => { r.rank = i + 1; r.lowVolume = minUO > 0 && r.uniqueOrders < minUO; });
  const me = tlFindMe(rows);
  const max = rows[0].approvePct || 1;
  const row = r => `<div class="dash-tl-row ${me && me.teamLeader === r.teamLeader ? 'is-me' : ''}">
      <span class="dash-medal">${r.rank <= 3 ? TL_MEDALS[r.rank - 1] : `<span class="dash-rank-n">${r.rank}</span>`}</span>
      ${eqAvatar(r.teamLeader)}
      <span class="dash-tl-main">
        <span class="dash-tl-name">${escapeHtml(r.teamLeader)}${me && me.teamLeader === r.teamLeader ? ' <span class="tl-you">Tú</span>' : ''}${r.lowVolume ? ' <span class="tl-low" title="Pocas órdenes todavía: el % puede ser casualidad">⚠</span>' : ''}</span>
        <span class="dash-tl-bar"><i style="width:${Math.max(3, (r.approvePct / max) * 100).toFixed(1)}%"></i></span>
      </span>
      <span class="dash-tl-pct">${r.approvePct.toFixed(2)}%</span>
    </div>`;
  const top = rows.slice(0, DASH_TL_N);
  body.innerHTML = top.map(row).join('')
    + (me && me.rank > DASH_TL_N ? `<div class="dash-tl-gap">···</div>${row(me)}` : '')
    + `<div class="dash-foot">% Approve = Approve ÷ Unique Orders · ${rows.length} Team Leaders en el ranking</div>`;
}

/* ══════════════════════════════
   EQUIPO HOY — asistencia, OPs por campaña, descansos de la semana, empresas y horarios
══════════════════════════════ */
const DASH_WEEKDAY_ORDER = ['LUNES', 'MARTES', 'MIERCOLES', 'JUEVES', 'VIERNES', 'SABADO', 'DOMINGO'];
const DASH_WEEKDAY_SHORT = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
function dashNormalizeDay(day) {
  return String(day || '').toUpperCase().trim().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
function dashTodayIndex() { return (new Date().getDay() + 6) % 7; }   // 0 = lunes

function dashCountBy(list, key) {
  const map = new Map();
  list.forEach(o => { const v = o[key] || 'Sin dato'; map.set(v, (map.get(v) || 0) + 1); });
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function dashRenderTeam() {
  const body = document.getElementById('dash-team-body');
  const t = dashData.team;
  if (t.error) { body.innerHTML = dashErrorHTML('la distribución'); return; }
  const team = dashTeamOps();
  if (!team.ops.length) { body.innerHTML = '<div class="dash-empty">La distribución está vacía — se sube desde Actualización de Data.</div>'; return; }
  const ops = team.ops;

  // 1) Asistencia: barra apilada con leyenda
  let attHTML;
  if (team.attOk) {
    const c = dashAttCounts(ops);
    const groups = DASH_ATT_GROUPS.filter(g => c[g.key] > 0);
    attHTML = `<div class="dash-att-bar">${groups.map(g => `<span class="${g.cls}" style="flex:${c[g.key]}" title="${g.label}: ${c[g.key]}"></span>`).join('')}</div>
      <div class="dash-att-legend">${groups.map(g => `<span><i class="${g.cls}"></i>${g.label} <strong>${c[g.key]}</strong></span>`).join('')}</div>`;
  } else {
    attHTML = `<div class="dash-empty">La hoja de asistencia no está disponible ahora${t.att && t.att.error ? ` (${escapeHtml(t.att.error.message || '')})` : ''}.</div>`;
  }

  // 2) OPs por campaña (con cuántos asistieron)
  const byPais = new Map();
  ops.forEach(o => {
    const p = byPais.get(o.pais) || { total: 0, present: 0 };
    p.total++;
    if (o.att === 'A') p.present++;
    byPais.set(o.pais, p);
  });
  const paisRows = [...byPais.entries()].sort((a, b) => b[1].total - a[1].total);
  const maxP = Math.max(1, ...paisRows.map(([, p]) => p.total));
  const paisHTML = paisRows.map(([pais, p]) => `<div class="dash-pais-row">
      <span class="dash-bar-name">${countryFlag(pais)}${escapeHtml(pais)}</span>
      <span class="dash-pais-track"><i style="width:${((p.total / maxP) * 100).toFixed(1)}%"></i>${team.attOk ? `<b style="width:${((p.present / maxP) * 100).toFixed(1)}%"></b>` : ''}</span>
      <span class="dash-pais-val">${team.attOk ? `<strong>${p.present}</strong>/${p.total}` : `<strong>${p.total}</strong>`}</span>
    </div>`).join('');

  // 3) Descansos: campaña × día de la semana, hoy resaltado
  const today = dashTodayIndex();
  const matrix = new Map();
  ops.forEach(o => {
    const i = DASH_WEEKDAY_ORDER.indexOf(dashNormalizeDay(o.descanso));
    if (i < 0) return;
    const row = matrix.get(o.pais) || Array(7).fill(0);
    row[i]++;
    matrix.set(o.pais, row);
  });
  const mRows = [...matrix.entries()].sort((a, b) => b[1].reduce((s, n) => s + n, 0) - a[1].reduce((s, n) => s + n, 0));
  const mMax = Math.max(1, ...mRows.flatMap(([, r]) => r));
  const colTotals = DASH_WEEKDAY_ORDER.map((_, i) => mRows.reduce((s, [, r]) => s + r[i], 0));
  const cell = (n, i) => `<td class="${i === today ? 'is-today' : ''}"${n ? ` style="--a:${(0.12 + (n / mMax) * 0.5).toFixed(2)}"` : ''}>${n || '<span class="txt-light">·</span>'}</td>`;
  const restHTML = mRows.length ? `<div class="tbl-wrap"><table class="dash-rest">
      <thead><tr><th>Campaña</th>${DASH_WEEKDAY_SHORT.map((d, i) => `<th class="${i === today ? 'is-today' : ''}">${d}${i === today ? '<small>hoy</small>' : ''}</th>`).join('')}</tr></thead>
      <tbody>${mRows.map(([pais, r]) => `<tr><td class="nowrap">${countryFlag(pais)}${escapeHtml(pais)}</td>${r.map(cell).join('')}</tr>`).join('')}</tbody>
      <tfoot><tr><td>Total</td>${colTotals.map((n, i) => `<td class="${i === today ? 'is-today' : ''}">${n}</td>`).join('')}</tr></tfoot>
    </table></div>` : '<div class="dash-empty">La distribución no tiene días de descanso cargados.</div>';

  // 4) Empresas y horarios
  const chips = (entries, badge) => entries.map(([v, n]) => `<span class="dash-chip">${badge(v)}<strong>${n}</strong></span>`).join('');

  body.innerHTML = `
    <div class="dash-team-col">
      <h4 class="dash-h4">Asistencia <span class="muted-11">· ${ops.length} OPs en la distribución</span></h4>
      ${attHTML}
      <h4 class="dash-h4">OPs por campaña <span class="muted-11">${team.attOk ? '· asistieron / total' : ''}</span></h4>
      <div class="dash-pais">${paisHTML}</div>
    </div>
    <div class="dash-team-col">
      <h4 class="dash-h4">Descansos de la semana <span class="muted-11">· hoy descansan ${colTotals[today]} OPs</span></h4>
      ${restHTML}
      <h4 class="dash-h4">Empresas</h4>
      <div class="dash-chips">${chips(dashCountBy(ops, 'empresa'), gdEmpresaBadge)}</div>
      <h4 class="dash-h4">Horarios</h4>
      <div class="dash-chips">${chips(dashCountBy(ops, 'horario'), gdScheduleBadge)}</div>
    </div>`;
}

/* ══════════════════════════════
   TU POSICIÓN — solo para quien es Team Leader en la distribución (Equipos 360)
   Se reconoce por el nombre de la cuenta (mismo emparejamiento que "Tú estás aquí" en Top TL: sin
   importar mayúsculas ni tildes, o todas las palabras del nombre). Cada tarjeta se muestra solo si la
   cuenta puede ver su sección, y calcula igual que la sección:
   · Top Team Leader: ranking por % Approve (sin baneados), distancia al de arriba / abajo.
   · Calidad: errores por OP del MES ACTUAL (mismo ranking de Equipos 360; desempata el approve de 90 días).
   · Ventas por Fuera: ventas del mes actual de los OPs de su equipo y su puesto entre los equipos.
══════════════════════════════ */
let dashPos = null;   // { me, teams: Map(tl → [nums]), errs, vf } o { me: null } o { error }

async function dashLoadPosition() {
  const dis = await sbFetchAll('dt_dis', 'select=PEROP1AM,TEAMLEADER&order=PEROP1AM.asc');
  const teams = new Map();
  const seen = new Set();
  (dis || []).forEach(d => {
    const tl = (d.TEAMLEADER || '').trim();
    const perop = (d.PEROP1AM || '').trim();
    const key = sheetOperatorNumber(perop) || perop;
    if (!tl || !key || seen.has(key)) return;
    seen.add(key);
    if (!teams.has(tl)) teams.set(tl, []);
    teams.get(tl).push(key);
  });
  const found = tlFindMe([...teams.keys()].map(teamLeader => ({ teamLeader })));
  if (!found) return { me: null };
  const [errs, vf] = await Promise.all([
    can('view.goodday') ? errFetch().catch(error => ({ error })) : null,
    can('view.ventasfuera') ? vfFetchSalesShared().catch(error => ({ error })) : null,
  ]);
  return { me: found.teamLeader, teams, errs, vf };
}

/* Ranking de Top TL (mismas reglas que la sección y que el bloque "Top Team Leaders") */
function dashTlRanking() {
  const t = dashData.tl;
  if (!t || t.error) return null;
  const banned = new Set((t.banned || []).map(b => b.team_leader));
  const rows = tlComputeRanking(t.raw).filter(r => !banned.has(r.teamLeader));
  const minUO = Math.round(tlMedian(rows.map(r => r.uniqueOrders)) * TL_LOW_VOLUME_RATIO);
  rows.forEach((r, i) => { r.rank = i + 1; r.lowVolume = minUO > 0 && r.uniqueOrders < minUO; });
  return rows;
}

/* Ranking de calidad del mes actual: menos errores por OP primero; desempata el approve (Approve Stats, 90 días) */
function dashQualityRanking(p) {
  if (!p.errs || p.errs.error) return null;
  const { start, end } = errPeriodBounds('cur');
  const errByNum = new Map();
  (p.errs.records || []).forEach(r => { if (errInRange(r, start, end)) errByNum.set(r.num, (errByNum.get(r.num) || 0) + 1); });
  const apByNum = new Map();
  Object.entries(window._opsIdx || {}).forEach(([operator, byCountry]) => {
    const num = sheetOperatorNumber(operator);
    if (!num) return;
    const cur = apByNum.get(num) || { total: 0, approve: 0 };
    Object.values(byCountry || {}).forEach(r => { cur.total += Number(r.Total) || 0; cur.approve += Number(r.Approve) || 0; });
    apByNum.set(num, cur);
  });
  const rows = [...p.teams.entries()].filter(([tl]) => tl !== '—').map(([tl, nums]) => {
    const errCount = nums.reduce((s, n) => s + (errByNum.get(n) || 0), 0);
    const ap = nums.reduce((acc, n) => { const x = apByNum.get(n); if (x) { acc.total += x.total; acc.approve += x.approve; } return acc; }, { total: 0, approve: 0 });
    return { tl, size: nums.length, errCount, errPerOp: nums.length ? errCount / nums.length : 0, approvePct: ap.total ? (ap.approve / ap.total) * 100 : null };
  });
  rows.sort((a, b) => (a.errPerOp - b.errPerOp) || ((b.approvePct ?? -1) - (a.approvePct ?? -1)) || a.tl.localeCompare(b.tl));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

/* Ventas por Fuera del mes actual, por equipo (mismas reglas: ORDEN CREADA, cada orden una vez) */
function dashVfRanking(p) {
  if (!p.vf || p.vf.error) return null;
  const month = vfMonthKey(0);
  const tlByNum = new Map();
  p.teams.forEach((nums, tl) => nums.forEach(n => tlByNum.set(n, tl)));
  const totals = new Map([...p.teams.keys()].map(tl => [tl, 0]));
  (p.vf.sales || []).forEach(s => { if (s.month === month && tlByNum.has(s.num)) { const tl = tlByNum.get(s.num); totals.set(tl, totals.get(tl) + 1); } });
  const rows = [...totals.entries()].filter(([tl]) => tl !== '—')
    .map(([tl, total]) => ({ tl, total, size: (p.teams.get(tl) || []).length }))
    .sort((a, b) => (b.total - a.total) || a.tl.localeCompare(b.tl));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

function dashRankChip(icon, rank, of, label) {
  return `<span class="dash-team-chip"><span>${icon}</span><strong>#${rank}</strong> de ${of} ${label}</span>`;
}

function dashRenderPosition() {
  const section = document.getElementById('dash-pos');
  const line = document.getElementById('dash-team-line');
  const p = dashPos;
  if (!p || p.error || !p.me) { section.hidden = true; line.hidden = true; return; }

  const size = (p.teams.get(p.me) || []).length;
  const tlRows = can('view.tl') ? dashTlRanking() : null;
  const tlMe = tlRows ? tlFindMe(tlRows) : null;
  const qRows = can('view.goodday') ? dashQualityRanking(p) : null;
  const qMe = qRows ? qRows.find(r => r.tl === p.me) : null;
  const vfRows = can('view.ventasfuera') ? dashVfRanking(p) : null;
  const vfMe = vfRows ? vfRows.find(r => r.tl === p.me) : null;

  // ── Saludo: tu equipo en una línea ──
  line.innerHTML = `<span class="dash-team-chip dash-team-chip--main">👥 Tu equipo: <strong>${size}</strong> OP${size === 1 ? '' : 's'}</span>`
    + (tlMe ? dashRankChip('🏆', tlMe.rank, tlRows.length, 'en Top TL') : '')
    + (qMe ? dashRankChip('🎯', qMe.rank, qRows.length, 'en calidad') : '')
    + (vfMe && vfMe.total ? dashRankChip('🛒', vfMe.rank, vfRows.length, 'en ventas por fuera') : '');
  line.hidden = false;

  // ── Tarjetas ──
  const cards = [];
  if (can('view.tl')) {
    let body;
    if (!tlRows) body = '<div class="dash-pos-empty">No se pudo leer el ranking.</div>';
    else if (!tlMe) body = '<div class="dash-pos-empty">Todavía no apareces en la data de Top Team Leader.</div>';
    else {
      const above = tlRows[tlMe.rank - 2], below = tlRows[tlMe.rank];
      const gap = above ? tlGapText(tlMe, above, 'Te faltan') : (below ? `¡Vas primero! ${tlGapText(tlMe, below, 'Le sacas')}` : '¡Vas primero!');
      body = `<div class="dash-pos-rank">#${tlMe.rank}<span> de ${tlRows.length}</span></div>
        <div class="dash-pos-value">${tlMe.approvePct.toFixed(2)}% <small>approve · ${tlMe.approve.toLocaleString('es-PE')} de ${tlMe.uniqueOrders.toLocaleString('es-PE')}</small></div>
        <div class="dash-pos-gap">${gap}</div>
        ${tlMe.lowVolume ? '<div class="dash-pos-note">⚠ Todavía tienes pocas órdenes comparado con el resto: tu % puede moverse mucho.</div>' : ''}`;
    }
    cards.push({ key: 'tl', icon: '🏆', title: 'Top Team Leader', page: 'tl', body, tone: tlMe && tlMe.rank <= 3 ? 'good' : '' });
  }
  if (can('view.goodday')) {
    let body;
    if (!qRows) body = '<div class="dash-pos-empty">No se pudieron leer las hojas de errores.</div>';
    else if (!qMe) body = '<div class="dash-pos-empty">Sin datos de tu equipo.</div>';
    else {
      const above = qRows[qMe.rank - 2];
      // Errores de menos que necesitaría para alcanzar (empatar) al de arriba
      const need = above ? Math.max(1, Math.ceil((qMe.errPerOp - above.errPerOp) * qMe.size - 1e-9)) : 0;
      const gap = !above
        ? (qMe.errCount ? '¡Eres el equipo con menos errores por OP!' : '¡Tu equipo no tiene errores este mes! 🎉')
        : (qMe.errPerOp === above.errPerOp
          ? `Estás <strong>empatado</strong> en errores por OP con ${escapeHtml(above.tl)} (#${above.rank}); te gana por approve.`
          : `Con <strong>${need} error${need === 1 ? '' : 'es'} menos</strong> alcanzarías a ${escapeHtml(above.tl)} (#${above.rank}).`);
      body = `<div class="dash-pos-rank">#${qMe.rank}<span> de ${qRows.length}</span></div>
        <div class="dash-pos-value">${qMe.errPerOp.toFixed(2)} <small>errores por OP · ${qMe.errCount} en ${escapeHtml(errPeriodLabel('cur'))}</small></div>
        <div class="dash-pos-gap">${gap}</div>`;
    }
    cards.push({ key: 'calidad', icon: '🎯', title: 'Calidad · mes actual', page: 'goodday', body, tone: qMe && qMe.rank <= 3 ? 'good' : '' });
  }
  if (can('view.ventasfuera')) {
    let body;
    if (!vfRows) body = '<div class="dash-pos-empty">No se pudieron leer las hojas de Ventas por Fuera.</div>';
    else if (!vfMe) body = '<div class="dash-pos-empty">Sin datos de tu equipo.</div>';
    else {
      const above = vfRows[vfMe.rank - 2];
      const gap = !vfMe.total ? 'Tu equipo todavía no tiene ventas por fuera este mes.'
        : !above ? '¡Tu equipo es el que más vende por fuera este mes!'
        : above.total === vfMe.total ? `Estás <strong>empatado</strong> en ventas con ${escapeHtml(above.tl)} (#${above.rank}).`
        : `Te faltan <strong>${above.total - vfMe.total}</strong> venta${above.total - vfMe.total === 1 ? '' : 's'} para alcanzar a ${escapeHtml(above.tl)} (#${above.rank}).`;
      body = `<div class="dash-pos-rank">#${vfMe.rank}<span> de ${vfRows.length}</span></div>
        <div class="dash-pos-value">${vfMe.total.toLocaleString('es-PE')} <small>ventas en ${escapeHtml(vfMonthLabel(0))} · ${vfMe.size ? (vfMe.total / vfMe.size).toFixed(1) : '0'} por OP</small></div>
        <div class="dash-pos-gap">${gap}</div>`;
    }
    cards.push({ key: 'vf', icon: '🛒', title: 'Ventas por Fuera · mes actual', page: 'ventasfuera', body, tone: vfMe && vfMe.total && vfMe.rank <= 3 ? 'good' : '' });
  }
  if (!cards.length) { section.hidden = true; return; }
  document.getElementById('dash-pos-grid').style.setProperty('--n', cards.length);
  document.getElementById('dash-pos-grid').innerHTML = cards.map(c => `
    <button type="button" class="dash-pos-card ${c.tone ? `dash-pos-card--${c.tone}` : ''}" onclick="goToPage('${c.page}')" title="Ver ${escapeHtml(c.title.split(' ·')[0])}">
      <div class="dash-pos-head"><span class="dash-pos-icon">${c.icon}</span><span class="dash-pos-title">${escapeHtml(c.title)}</span><span class="dash-pos-go">→</span></div>
      ${c.body}
    </button>`).join('');
  document.getElementById('dash-pos-sub').textContent = `equipo de ${p.me}`;
  section.hidden = false;
}
