/* Sidebar dinámico (grupos por color) y la vista "Configurar Sidebar". */

/* ══════════════════════════════
   SIDEBAR — grupos por color, sin secciones desplegables. La organización y los
   colores se guardan en dt_sidebar_config y se comparten para todo el equipo; solo
   Supervisor puede editarlos, desde "Configurar Sidebar".
══════════════════════════════ */
const SIDEBAR_ITEMS = {
  dashboard:     { label: 'Inicio', page: 'dashboard', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>' },
  goodday:       { label: 'Equipos 360', page: 'goodday', badge: 'Nuevo', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>' },
  ops:           { label: 'Approve Stats', page: 'ops', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 14l-5-5 1.41-1.41L12 14.17l7.59-7.59L21 8l-9 9z"/></svg>' },
  opstoday:      { label: 'Stats OPs Today', page: 'opstoday', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>' },
  opslive:       { label: 'Stats OPs Live', page: 'opslive', badge: 'Nuevo', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.97-4-4L2 16.99z"/><circle cx="19" cy="5" r="2.5"/></svg>' },
  reportes:      { label: 'Reporte', page: 'reportes', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>' },
  recalls:       { label: 'Gestión de Recalls', page: 'recalls', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>' },
  leads:         { label: 'Leads por Campaña', page: 'leads', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-2.18c.11-.31.18-.65.18-1a2 2 0 0 0-2-2c-1.05 0-1.96.54-2.5 1.35l-.5.67-.5-.68C11.96 3.54 11.05 3 10 3a2 2 0 0 0-2 2c0 .35.07.69.18 1H6c-1.11 0-1.99.89-1.99 2L4 19c0 1.11.89 2 2 2h12c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-6-1c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zM6 8h12v3H6V8zm0 5h5v6H6v-6zm7 6v-6h5v6h-5z"/></svg>' },
  ventasfuera:   { label: 'Ventas por Fuera', page: 'ventasfuera', badge: 'Nuevo', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 18c-1.1 0-1.99.9-1.99 2S5.9 22 7 22s2-.9 2-2-.9-2-2-2zM1 2v2h2l3.6 7.59-1.35 2.45c-.16.28-.25.61-.25.96 0 1.1.9 2 2 2h12v-2H7.42c-.14 0-.25-.11-.25-.25l.03-.12.9-1.63h7.45c.75 0 1.41-.41 1.75-1.03l3.58-6.49A1.003 1.003 0 0 0 20 4H5.21l-.94-2H1zm16 16c-1.1 0-1.99.9-1.99 2s.89 2 1.99 2 2-.9 2-2-.9-2-2-2z"/></svg>' },
  tl:            { label: 'Top Team Leader', page: 'tl', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5zm14 3H5v-2h14v2z"/></svg>' },
  actualizacion: { label: 'Actualización de Data', page: 'actualizacion', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM14 13v4h-4v-4H7l5-5 5 5h-3z"/></svg>' },
  accounts:      { label: 'Gestión de Cuentas', page: 'accounts', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>' },
  // adminOnly: no entra en la configuración compartida (dt_sidebar_config) ni en "Configurar Sidebar";
  // sale solo en el grupo privado "Laboratorio" de la cuenta que tenga el permiso (Admin).
  seguimiento:   { label: 'Seguimiento', page: 'seguimiento', adminOnly: true, icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z"/></svg>' },
  sidebarconfig: { label: 'Configurar Sidebar', page: 'sidebarconfig', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>' },
};

function sidebarDefaultGroups() {
  return [
    { id: 'g-principal',   label: 'Principal',   color: '#4c8dff', items: ['dashboard', 'goodday', 'ops', 'opstoday', 'opslive'] },
    { id: 'g-operacion',   label: 'Operación',   color: '#22c55e', items: ['reportes', 'recalls', 'leads', 'ventasfuera'] },
    { id: 'g-rendimiento', label: 'Rendimiento', color: '#c084fc', items: ['tl'] },
    { id: 'g-sistema',     label: 'Sistema',     color: '#9ca8b5', items: ['actualizacion', 'accounts', 'sidebarconfig'] },
  ];
}

let sidebarConfig = sidebarDefaultGroups();      // valor de partida hasta que cargue lo guardado (si hay)
let sidebarConfigSaved = sidebarDefaultGroups(); // último estado realmente guardado — para "Descartar cambios"

async function loadSidebarConfig() {
  try {
    const rows = await sbFetch('dt_sidebar_config', 'select=*&order=updated_at.desc&limit=1');
    if (rows && rows[0] && Array.isArray(rows[0].groups) && rows[0].groups.length > 0) {
      sidebarConfig = rows[0].groups;
    }
  } catch (err) {
    console.error('Error cargando configuración de sidebar, se usa la de por defecto:', err);
  }
  sidebarAddMissingItems(sidebarConfig);
  sidebarConfigSaved = JSON.parse(JSON.stringify(sidebarConfig));
  renderSidebar();
}

/* Secciones nuevas que todavía no están en la configuración guardada (dt_sidebar_config):
   se ubican justo después de su "vecina" (SIDEBAR_AFTER), o al final del primer grupo.
   Solo en memoria — queda fija para todos cuando un Supervisor guarde el sidebar. */
const SIDEBAR_AFTER = { opslive: 'opstoday', ventasfuera: 'leads' };
function sidebarAddMissingItems(groups) {
  if (!groups.length) return;
  const placed = new Set(groups.flatMap(g => g.items || []));
  Object.keys(SIDEBAR_ITEMS).forEach(id => {
    if (placed.has(id) || SIDEBAR_ITEMS[id].adminOnly) return;
    const after = SIDEBAR_AFTER[id];
    const host = groups.find(g => (g.items || []).includes(after)) || groups[0];
    host.items = host.items || [];
    const pos = host.items.indexOf(after);
    host.items.splice(pos === -1 ? host.items.length : pos + 1, 0, id);
    placed.add(id);
  });
}

/* ── Menú móvil (≤720px): el sidebar se abre como panel deslizable con fondo oscuro ── */
function sidebarSetMobileOpen(open) {
  document.getElementById('app-sidebar').classList.toggle('open', open);
  document.getElementById('sidebar-backdrop').classList.toggle('open', open);
  document.body.classList.toggle('sidebar-open', open);
  const btn = document.getElementById('topbar-menu-btn');
  btn.setAttribute('aria-expanded', String(open));
  btn.setAttribute('aria-label', open ? 'Cerrar menú' : 'Abrir menú');
}
function sidebarToggleMobile() {
  sidebarSetMobileOpen(!document.getElementById('app-sidebar').classList.contains('open'));
}
function sidebarCloseMobile() { sidebarSetMobileOpen(false); }

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('app-sidebar').classList.contains('open')) sidebarCloseMobile();
});
// Si la pantalla se agranda con el menú abierto (rotar el celular), no queda el fondo oscuro pegado
window.matchMedia('(min-width: 721px)').addEventListener('change', (e) => { if (e.matches) sidebarCloseMobile(); });

/* El color de grupo viene de dt_sidebar_config y se concatena con alpha hex (`${color}33`),
   así que solo se acepta #rrggbb — cualquier otra cosa cae a gris. */
function sidebarSafeColor(color) {
  return /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#9ca8b5';
}

/* Grupo privado de la cuenta Admin: nunca se guarda en dt_sidebar_config, existe solo en su menú */
const SIDEBAR_LAB_GROUP = { id: 'g-laboratorio', label: '🧪 Laboratorio', color: '#f59e0b' };

function renderSidebar() {
  const container = document.getElementById('sidebar-nav-container');
  if (!container) return;
  const labItems = Object.keys(SIDEBAR_ITEMS).filter(id => SIDEBAR_ITEMS[id].adminOnly);
  const groups = [...sidebarConfig, { ...SIDEBAR_LAB_GROUP, items: labItems }];
  container.innerHTML = groups.map(group => {
    const color = sidebarSafeColor(group.color);
    const isLab = group.id === SIDEBAR_LAB_GROUP.id;
    // Cada sección se ve solo si la cuenta tiene su permiso (SECTION_PERM en core/permissions.js).
    // Las de Admin solo van en el Laboratorio, aunque alguien las metiera en la configuración compartida.
    const visibleItems = (group.items || []).filter(id => SIDEBAR_ITEMS[id] && canSeePage(SIDEBAR_ITEMS[id].page)
      && !!SIDEBAR_ITEMS[id].adminOnly === isLab);
    if (visibleItems.length === 0) return '';
    const itemsHtml = visibleItems.map(id => {
      const item = SIDEBAR_ITEMS[id];
      return `<div class="nav-item" id="nav-${id}" style="--item-color:${color};--item-bg-active:${color}33" onclick="setNav(this, '${item.page}')">
        ${item.icon}
        ${item.label}
        ${item.badge ? `<span class="nav-badge">${item.badge}</span>` : ''}
      </div>`;
    }).join('');
    return `<div class="sidebar-section-label" style="--c:${color}">${escapeHtml(group.label)}</div>${itemsHtml}`;
  }).join('');

  // Un re-render reemplaza todo el DOM del nav — hay que volver a marcar activo el item actual
  const activeId = Object.keys(SIDEBAR_ITEMS).find(id => SIDEBAR_ITEMS[id].page === currentPage);
  const activeEl = activeId ? document.getElementById(`nav-${activeId}`) : null;
  if (activeEl) activeEl.classList.add('active');
}

/* ── Configurar Sidebar: edición en vivo (solo en memoria) + guardado compartido ── */
function sidebarConfigInitView() {
  renderSidebarConfigAdmin();
}

function renderSidebarConfigAdmin() {
  const wrap = document.getElementById('sbcfg-groups');
  if (!wrap) return;
  wrap.innerHTML = sidebarConfig.map(g => {
    const items = g.items || [];
    const color = sidebarSafeColor(g.color);
    const gid = jsArg(g.id);
    const itemsHtml = items.length === 0
      ? `<div class="sbcfg-empty">Sin secciones — muévelas aquí desde otro grupo</div>`
      : items.map((id, idx) => {
          const item = SIDEBAR_ITEMS[id];
          if (!item) return '';
          const groupOptions = sidebarConfig.map(g2 => `<option value="${escapeHtml(g2.id)}" ${g2.id === g.id ? 'selected' : ''}>${escapeHtml(g2.label)}</option>`).join('');
          return `<div class="sbcfg-item">
            <span class="sbcfg-item-icon">${item.icon}</span>
            <span class="sbcfg-item-label">${item.label} <span class="sbcfg-item-perm">(permiso: ${escapeHtml(permLabel(SECTION_PERM[item.page]))})</span></span>
            <button class="btn btn-ghost btn-sm btn-arrow" ${idx === 0 ? 'disabled' : ''} onclick="sidebarMoveItem(${gid},'${id}',-1)" title="Subir" aria-label="Subir">▲</button>
            <button class="btn btn-ghost btn-sm btn-arrow" ${idx === items.length - 1 ? 'disabled' : ''} onclick="sidebarMoveItem(${gid},'${id}',1)" title="Bajar" aria-label="Bajar">▼</button>
            <select class="sbcfg-select" onchange="sidebarReassignItem('${id}', this.value)" aria-label="Grupo de ${escapeHtml(item.label)}">${groupOptions}</select>
          </div>`;
        }).join('');

    return `
    <div class="panel sbcfg-group" style="--c:${color}">
      <div class="panel-head">
        <button class="btn btn-ghost btn-sm btn-arrow" onclick="sidebarMoveGroup(${gid},-1)" title="Subir grupo" aria-label="Subir grupo">▲</button>
        <button class="btn btn-ghost btn-sm btn-arrow" onclick="sidebarMoveGroup(${gid},1)" title="Bajar grupo" aria-label="Bajar grupo">▼</button>
        <input type="text" class="sbcfg-name" value="${escapeHtml(g.label)}" oninput="sidebarUpdateGroupLabel(${gid}, this.value)" aria-label="Nombre del grupo" />
        <input type="color" class="sbcfg-color" value="${color}" onchange="sidebarUpdateGroupColor(${gid}, this.value)" title="Color del grupo" aria-label="Color del grupo"/>
        <span class="sbcfg-count">${items.length} sección${items.length === 1 ? '' : 'es'}</span>
        <button class="btn btn-ghost btn-sm sbcfg-del" onclick="sidebarRemoveGroup(${gid})" title="Eliminar grupo" aria-label="Eliminar grupo">🗑</button>
      </div>
      <div class="panel-body">${itemsHtml}</div>
    </div>`;
  }).join('');
}

function sidebarMarkUnsaved() {
  const status = document.getElementById('sbcfg-status');
  if (status) { status.style.color = 'var(--amber)'; status.textContent = 'Cambios sin guardar — presiona "Guardar para todos" para que el equipo los vea.'; }
}

function sidebarLiveRefresh() {
  renderSidebar();
  renderSidebarConfigAdmin();
  sidebarMarkUnsaved();
}

async function sidebarAddGroup() {
  const label = await uiPrompt('Así se va a ver el título del grupo en el menú lateral.', {
    title: 'Nuevo grupo', defaultValue: 'Nuevo grupo', confirmText: 'Crear grupo',
  });
  if (label === null) return;
  sidebarConfig.push({ id: `g-${Date.now()}`, label: label.trim(), color: '#4c8dff', items: [] });
  sidebarLiveRefresh();
}

async function sidebarRemoveGroup(groupId) {
  const g = sidebarConfig.find(x => x.id === groupId);
  if (!g) return;
  if ((g.items || []).length > 0) {
    await uiAlert('Primero mueve o quita las secciones de este grupo antes de eliminarlo.', { title: 'El grupo no está vacío', tone: 'warning' });
    return;
  }
  if (sidebarConfig.length <= 1) {
    await uiAlert('Tiene que quedar al menos un grupo.', { title: 'No se puede eliminar', tone: 'warning' });
    return;
  }
  const ok = await uiConfirm(`Se eliminará el grupo "${g.label}".`, { title: '¿Eliminar grupo?', confirmText: 'Eliminar', danger: true });
  if (!ok) return;
  sidebarConfig = sidebarConfig.filter(x => x.id !== groupId);
  sidebarLiveRefresh();
}

function sidebarMoveGroup(groupId, dir) {
  const idx = sidebarConfig.findIndex(g => g.id === groupId);
  const newIdx = idx + dir;
  if (idx === -1 || newIdx < 0 || newIdx >= sidebarConfig.length) return;
  const [g] = sidebarConfig.splice(idx, 1);
  sidebarConfig.splice(newIdx, 0, g);
  sidebarLiveRefresh();
}

function sidebarUpdateGroupLabel(groupId, value) {
  const g = sidebarConfig.find(x => x.id === groupId);
  if (!g) return;
  g.label = value;
  renderSidebar(); // ojo: no redibuja el panel de admin, así el input no pierde el foco mientras se escribe
  sidebarMarkUnsaved();
}

function sidebarUpdateGroupColor(groupId, value) {
  const g = sidebarConfig.find(x => x.id === groupId);
  if (!g) return;
  g.color = value;
  sidebarLiveRefresh();
}

function sidebarMoveItem(groupId, itemId, dir) {
  const g = sidebarConfig.find(x => x.id === groupId);
  if (!g) return;
  const idx = g.items.indexOf(itemId);
  const newIdx = idx + dir;
  if (idx === -1 || newIdx < 0 || newIdx >= g.items.length) return;
  g.items.splice(idx, 1);
  g.items.splice(newIdx, 0, itemId);
  sidebarLiveRefresh();
}

function sidebarReassignItem(itemId, newGroupId) {
  const fromGroup = sidebarConfig.find(g => (g.items || []).includes(itemId));
  const toGroup = sidebarConfig.find(g => g.id === newGroupId);
  if (!toGroup || fromGroup === toGroup) return;
  if (fromGroup) fromGroup.items = fromGroup.items.filter(id => id !== itemId);
  toGroup.items = toGroup.items || [];
  toGroup.items.push(itemId);
  sidebarLiveRefresh();
}

function sidebarConfigDiscard() {
  sidebarConfig = JSON.parse(JSON.stringify(sidebarConfigSaved));
  renderSidebar();
  renderSidebarConfigAdmin();
  const status = document.getElementById('sbcfg-status');
  if (status) {
    status.style.color = 'var(--text-light)';
    status.textContent = 'Cambios descartados.';
    setTimeout(() => { status.textContent = ''; }, 4000);
  }
}

async function sidebarConfigSave() {
  if (!can('sidebar.manage')) return;
  const btn = document.getElementById('sbcfg-save-btn');
  const status = document.getElementById('sbcfg-status');
  btn.disabled = true;
  status.style.color = 'var(--text-light)';
  status.textContent = 'Guardando...';
  try {
    const user = getCurrentUser();
    await sbInsert('dt_sidebar_config', [{ groups: sidebarConfig, updated_by: user ? user[0] : null }]);
    sidebarConfigSaved = JSON.parse(JSON.stringify(sidebarConfig));
    status.style.color = 'var(--green)';
    status.textContent = '✓ Guardado — ya se ve así para todo el equipo.';
    setTimeout(() => { status.textContent = ''; }, 6000);
  } catch (err) {
    console.error('Error guardando configuración de sidebar:', err);
    status.style.color = 'var(--red)';
    status.textContent = (err && err.message) ? err.message : 'No se pudo guardar, intenta de nuevo.';
  } finally {
    btn.disabled = false;
  }
}
