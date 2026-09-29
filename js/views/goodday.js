/* Vista GoodDay — distribución de agentes (dt_dis) + badges visuales compartidos (país, día, horario, empresa). */

/* ══════════════════════════════
   GOODDAY — SUPABASE
══════════════════════════════ */
// Columnas en dt_dis — nombres exactos como están en Supabase
const GD_COLS = ['TEAMLEADER','ASESORES','PEROP1AM','PAIS','DESCANSO','HORARIO','EMPRESA','ASISTENCIA'];
const GD_COL_LABELS = { 'TEAMLEADER':'Team Leader', 'ASESORES':'Asesor', 'PEROP1AM':'PEROP1AM', 'PAIS':'País', 'DESCANSO':'Descanso', 'HORARIO':'Horario', 'EMPRESA':'Empresa', 'ASISTENCIA':'Asistencia' };

let gdRawData  = [];
let gdFiltered = [];
let gdLoaded   = false;
let gdSortDir  = {};

/* silent = refresco automático (autoRefreshTick): sin spinner ni "Cargando…", conserva filtros y orden */
async function loadGoodDay(silent = false) {
  const spinIcon = document.getElementById('gd-spin-icon');
  spinIcon.classList.add('spin');
  if (!silent) {
    document.getElementById('gd-loading').style.display = 'flex';
    document.getElementById('gd-table').style.display   = 'none';
    document.getElementById('gd-empty').style.display   = 'none';
  }

  try {
    const cols = GD_COLS.join(',');
    // La asistencia viene EN VIVO de su hoja de Google (core/attendance.js). Si esa hoja falla,
    // GoodDay igual se muestra (con lo que tenga dt_dis) y se avisa en la barra de arriba.
    const [data, att] = await Promise.all([
      sbFetch('dt_dis', `select=${cols}&order=TEAMLEADER.asc`),
      attFetch(true).catch(err => { console.error('Asistencia no disponible:', err); return { error: err }; }),
    ]);

    // Convertir objetos a arrays ordenados por GD_COLS (índice 7 = ASISTENCIA)
    gdRawData = data.map(row => {
      const r = GD_COLS.map(c => row[c] || '');
      if (att.map) {
        const num = sheetOperatorNumber(r[2]);
        r[7] = (num && att.map.get(num)) || '';
      }
      return r;
    });
    gdRenderAttendanceStatus(att);

    // Inyectar encabezados en la tabla
    document.getElementById('gd-thead-row').innerHTML = GD_COLS
      .map((c, i) => `<th onclick="sortGD(${i})">${GD_COL_LABELS[c] || c} <span class="sort-icon">↕</span></th>`)
      .join('');

    // Actualizar etiquetas de filtros
    const filterLabelMap = {
      'gd-f-tl':   'TEAMLEADER',
      'gd-f-camp': 'PAIS',
      'gd-f-emp':  'EMPRESA',
      'gd-f-hor':  'HORARIO',
      'gd-f-desc': 'DESCANSO'
    };
    Object.entries(filterLabelMap).forEach(([id, col]) => {
      const sel = document.getElementById(id);
      if (sel) {
        const label = sel.previousElementSibling;
        if (label && label.tagName === 'LABEL')
          label.textContent = (GD_COL_LABELS[col] || col) + ':';
      }
    });

    gdLoaded = true;
    populateGDFilters();
    applyGDFilters();

    const now = new Date();
    document.getElementById('gd-last-update').textContent =
      `Actualizado: ${now.toLocaleTimeString('es-ES', {hour:'2-digit',minute:'2-digit',second:'2-digit'})}`;

  } catch (err) {
    if (silent) { console.error('Error en refresco de GoodDay:', err); return; }
    document.getElementById('gd-loading').innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
      <p>No se pudo cargar los datos</p>
      <small>${escapeHtml(err.message)}</small>`;
    document.getElementById('gd-loading').style.display = 'flex';
  } finally {
    spinIcon.classList.remove('spin');
  }
}

/* Chip "Asistieron: N" + aviso si la hoja de asistencia no se pudo leer */
function gdRenderAttendanceStatus(att) {
  const warn = document.getElementById('gd-att-warn');
  const present = document.getElementById('gd-present');
  if (att.error) {
    warn.hidden = false;
    warn.title = att.error.message || 'No se pudo leer la hoja de asistencia';
    present.textContent = '—';
    return;
  }
  warn.hidden = true;
  present.textContent = gdRawData.filter(r => attIsPresent(r[7])).length;
  const legend = document.getElementById('gd-att-legend');
  if (!legend.innerHTML) legend.innerHTML = attLegendHTML();
  legend.hidden = false;
}

/* ── Carga de Excel/CSV/TSV para dt_dis (reemplazo total), usada desde "Actualización de Data" ──
   Encabezado actual: TEAMLEADER ASESORES PEROP1AM PAIS DESCANSO HORARIO IGNORAR IGNORAR IGNORAR EMPRESA ASISTENCIA
   La lectura es por NOMBRE de encabezado, no por posición — solo se toman las columnas listadas
   en GD_COLS; cualquier columna llamada "IGNORAR" (haya una o varias) nunca calza con ningún
   nombre de GD_COLS, así que se descarta sola sin necesidad de lógica especial.
   GD_HEADER_ALIASES cubre nombres alternativos que ha tenido la misma columna en versiones
   anteriores del archivo (p.ej. "CAMPAÑA" para lo que en dt_dis sigue siendo la columna PAIS). */
const GD_HEADER_ALIASES = {
  'PAIS': ['PAIS', 'PAÍS', 'CAMPAÑA', 'CAMPANA'],
};

function gdParseWorkbook(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (raw.length === 0) return [];

  const headers = Object.keys(raw[0]);
  const keyMap = {};
  headers.forEach(h => { keyMap[recNormalizeHeader(h)] = h; });

  return raw.map(row => {
    const record = {};
    GD_COLS.forEach(col => {
      const candidates = GD_HEADER_ALIASES[col] || [col];
      const actualKey = candidates.map(c => keyMap[c.toLowerCase()]).find(k => k !== undefined);
      record[col] = actualKey !== undefined ? String(row[actualKey] ?? '').trim() : '';
    });
    return record;
  // El archivo suele traer, después de las filas reales, bloques de relleno (filas vacías)
  // y una tabla-resumen tipo "CONECTADOS Y CAMPAÑAS" con solo PEROP1AM y todo lo demás en blanco.
  // Exigir también TEAMLEADER descarta ambos casos y deja solo las filas de asignación reales.
  }).filter(r => r.PEROP1AM && r.TEAMLEADER);
}

async function gdDeleteAllCurrent() {
  const res = await fetch(`${SB_URL}/rest/v1/dt_dis?PEROP1AM=not.is.null`, {
    method: 'DELETE',
    headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error(`Supabase delete error ${res.status}`);
}

async function gdFetchLastUpload() {
  try {
    const rows = await sbFetch('dt_dis', 'select=uploaded_at&order=uploaded_at.desc&limit=1');
    return (rows && rows.length > 0) ? rows[0].uploaded_at : null;
  } catch (err) {
    console.error('Error obteniendo fecha de carga de dt_dis:', err);
    return null;
  }
}

const GD_ATT_EMPTY = '__sin_marcar__'; // valor del filtro "Sin marcar" (asistencia vacía)

function populateGDFilters() {
  // "Sin marcar" no está entre los valores únicos: se recuerda aparte para no perderlo al refrescar
  const asisPrev = document.getElementById('gd-f-asis').value;
  document.getElementById('gd-f-asis').dataset.prev = asisPrev;
  // col indices: 0=TEAMLEADER, 1=ASESORES, 2=PEROPIAM, 3=PAIS, 4=DESCANSO, 5=HORARIO, 6=EMPRESA
  const unique = (col) => [...new Set(gdRawData.map(r => r[col]).filter(Boolean))].sort();
  const fillSelect = (id, values) => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '<option value="">Todos</option>' +
      values.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
    if (prev) sel.value = prev;
  };
  fillSelect('gd-f-tl',   unique(0)); // TEAMLEADER
  fillSelect('gd-f-camp', unique(3)); // PAIS
  fillSelect('gd-f-emp',  unique(6)); // EMPRESA
  fillSelect('gd-f-hor',  unique(5)); // HORARIO
  fillSelect('gd-f-desc', unique(4)); // DESCANSO
  // ASISTENCIA: el valor es el código de la hoja (A, OFF, Fa…); el texto agrega su significado
  const asisSel = document.getElementById('gd-f-asis');
  asisSel.innerHTML = '<option value="">Todos</option>' + unique(7).map(v => {
    const meaning = attMeaning(v);
    return `<option value="${escapeHtml(v)}">${escapeHtml(meaning ? `${v} — ${meaning}` : v)}</option>`;
  }).join('');
  if (unique(7).includes(asisSel.dataset.prev)) asisSel.value = asisSel.dataset.prev;
  // + opción para ver a quién todavía no le marcaron asistencia
  if (gdRawData.some(r => !r[7])) asisSel.insertAdjacentHTML('beforeend', `<option value="${GD_ATT_EMPTY}">Sin marcar</option>`);
  if (asisSel.dataset.prev === GD_ATT_EMPTY) asisSel.value = GD_ATT_EMPTY;

  document.getElementById('gd-campaigns').textContent = unique(3).length;
  document.getElementById('gd-companies').textContent = unique(6).length;
}

function applyGDFilters() {
  const tl     = document.getElementById('gd-f-tl').value;
  const camp   = document.getElementById('gd-f-camp').value;
  const emp    = document.getElementById('gd-f-emp').value;
  const hor    = document.getElementById('gd-f-hor').value;
  const desc   = document.getElementById('gd-f-desc').value;
  const asis   = document.getElementById('gd-f-asis').value;
  const search = document.getElementById('gd-search').value.toLowerCase();

  gdFiltered = gdRawData.filter(r => {
    if (tl   && r[0] !== tl)   return false;
    if (camp && r[3] !== camp) return false;
    if (emp  && r[6] !== emp)  return false;
    if (hor  && r[5] !== hor)  return false;
    if (desc && r[4] !== desc) return false;
    if (asis && (asis === GD_ATT_EMPTY ? r[7] !== '' : r[7] !== asis)) return false;
    if (search && !r[1].toLowerCase().includes(search)) return false;
    return true;
  });

  // Update pill active states
  const pillMap = { 'pill-tl': tl, 'pill-camp': camp, 'pill-emp': emp, 'pill-hor': hor, 'pill-desc': desc, 'pill-asis': asis };
  let anyActive = search.length > 0;
  Object.entries(pillMap).forEach(([pillId, val]) => {
    const pill = document.getElementById(pillId);
    if (pill) {
      pill.classList.toggle('active', !!val);
      if (val) anyActive = true;
    }
  });
  // Show/hide clear-all button
  const clearBtn = document.getElementById('gd-clear-btn');
  if (clearBtn) clearBtn.style.display = anyActive ? 'flex' : 'none';
  // Search wrap highlight
  const sw = document.querySelector('#view-goodday .gd-search-wrap');
  if (sw) sw.classList.toggle('active', search.length > 0);

  renderGDTable();
}

function clearGDFilters() {
  ['gd-f-tl','gd-f-camp','gd-f-emp','gd-f-hor','gd-f-desc','gd-f-asis'].forEach(id => {
    document.getElementById(id).value = '';
  });
  document.getElementById('gd-search').value = '';
  applyGDFilters();
}

function clearPill(selectId) {
  document.getElementById(selectId).value = '';
  applyGDFilters();
}

/* Row color by PEROP1AM value */
function gdPeropBadge(val) {
  const v = val ? val.toString().trim() : '';
  if (!v || v === '—') return `<span style="color:var(--text-light)">—</span>`;
  const n = parseFloat(v.replace('%',''));
  if (!isNaN(n)) {
    const cls = n >= 85 ? 'badge-green' : n >= 65 ? 'badge-amber' : 'badge-red';
    return `<span class="badge ${cls}">${escapeHtml(v)}</span>`;
  }
  return `<span>${escapeHtml(v)}</span>`;
}

/* ── Visual helpers ── */
const COUNTRY_FLAGS = {
  'ECUADOR':      '🇪🇨',
  'PERU':         '🇵🇪',
  'PERÚ':         '🇵🇪',
  'COLOMBIA':     '🇨🇴',
  'CHILE':        '🇨🇱',
  'ARGENTINA':    '🇦🇷',
  'MEXICO':       '🇲🇽',
  'MÉXICO':       '🇲🇽',
  'BOLIVIA':      '🇧🇴',
  'VENEZUELA':    '🇻🇪',
  'URUGUAY':      '🇺🇾',
  'PARAGUAY':     '🇵🇾',
  'COSTA RICA':   '🇨🇷',
  'PANAMA':       '🇵🇦',
  'PANAMÁ':       '🇵🇦',
  'GUATEMALA':    '🇬🇹',
  'HONDURAS':     '🇭🇳',
  'EL SALVADOR':  '🇸🇻',
  'NICARAGUA':    '🇳🇮',
  'ESPAÑA':       '🇪🇸',
  'ESPANA':       '🇪🇸',
  'SIN PROGRAMAR':'⚠️',
};

const DAY_COLORS = {
  'LUNES':     { bg:'rgba(37,99,235,.12)',  color:'#2563eb' },
  'MARTES':    { bg:'rgba(192,38,211,.12)', color:'#c026d3' },
  'MIÉRCOLES': { bg:'rgba(180,83,9,.12)',   color:'#b45309' },
  'MIERCOLES': { bg:'rgba(180,83,9,.12)',   color:'#b45309' },
  'JUEVES':    { bg:'rgba(5,150,105,.12)',  color:'#059669' },
  'VIERNES':   { bg:'rgba(194,65,12,.12)',  color:'#c2410c' },
  'SÁBADO':    { bg:'rgba(124,58,237,.12)', color:'#7c3aed' },
  'SABADO':    { bg:'rgba(124,58,237,.12)', color:'#7c3aed' },
  'DOMINGO':   { bg:'rgba(220,38,38,.12)',  color:'#dc2626' },
};

const SCHEDULE_COLORS = {
  '06:00-15:00': { bg:'rgba(161,98,7,.10)',  color:'#a16207' },
  '07:00-16:00': { bg:'rgba(180,83,9,.10)',  color:'#b45309' },
  '08:00-17:00': { bg:'rgba(2,132,199,.10)', color:'#0284c7' },
  '09:00-18:00': { bg:'rgba(22,163,74,.10)', color:'#16a34a' },
  '10:00-19:00': { bg:'rgba(5,150,105,.10)', color:'#059669' },
  '11:00-20:00': { bg:'rgba(124,58,237,.10)',color:'#7c3aed' },
  '12:00-21:00': { bg:'rgba(219,39,119,.10)',color:'#db2777' },
  '13:00-22:00': { bg:'rgba(220,38,38,.10)', color:'#dc2626' },
  '14:00-23:00': { bg:'rgba(185,28,28,.12)', color:'#b91c1c' },
  '22:00-07:00': { bg:'rgba(71,85,105,.08)', color:'#475569' },
};

const EMPRESA_COLORS = {
  'CALLYPSO':  { bg:'rgba(220,38,38,.10)',  color:'#dc2626', dot:'#dc2626' },
  'PRIMA':     { bg:'rgba(37,99,235,.10)',  color:'#2563eb', dot:'#2563eb' },
  'INTEGRAL':  { bg:'rgba(22,163,74,.10)',  color:'#16a34a', dot:'#16a34a' },
  'SIN DATA':  { bg:'rgba(255,255,255,.05)', color:'#a7acb1', dot:'#8d9296' },
};

function gdCountryBadge(val) {
  const v = (val || '').trim();
  if (!v || v === '—') return `<span style="color:var(--text-light)">—</span>`;
  return `<span style="display:inline-flex;align-items:center;font-size:12px;font-weight:600;padding:3px 10px;background:var(--blue-soft);color:var(--blue);border-radius:99px">${escapeHtml(v)}</span>`;
}

function gdDayBadge(val) {
  const v = (val || '').toUpperCase().trim();
  if (!v || v === '—' || v === 'EMPTY') return `<span style="color:var(--text-light)">—</span>`;
  const c = DAY_COLORS[v] || { bg:'var(--main-bg)', color:'var(--text-mid)' };
  return `<span style="display:inline-block;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:700;background:${c.bg};color:${c.color}">${escapeHtml(val)}</span>`;
}

function gdScheduleBadge(val) {
  const v = (val || '').trim();
  if (!v || v === '—') return `<span style="color:var(--text-light)">—</span>`;
  // Find matching key (partial match)
  const key = Object.keys(SCHEDULE_COLORS).find(k => v.includes(k.split('-')[0])) || '';
  const c = SCHEDULE_COLORS[key] || { bg:'var(--main-bg)', color:'var(--text-mid)' };
  return `<span style="display:inline-block;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:600;background:${c.bg};color:${c.color};font-variant-numeric:tabular-nums">${escapeHtml(val)}</span>`;
}

function gdEmpresaBadge(val) {
  const v = (val || '').toUpperCase().trim();
  if (!v || v === '—') return `<span style="color:var(--text-light)">—</span>`;
  const c = EMPRESA_COLORS[v] || { bg:'var(--main-bg)', color:'var(--text-mid)', dot:'var(--text-light)' };
  return `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:700;background:${c.bg};color:${c.color}">
    <span style="width:6px;height:6px;border-radius:50%;background:${c.dot};flex-shrink:0"></span>${escapeHtml(val)}
  </span>`;
}

function renderGDTable() {
  const tbody   = document.getElementById('gd-tbody');
  const table   = document.getElementById('gd-table');
  const empty   = document.getElementById('gd-empty');
  const loading = document.getElementById('gd-loading');

  loading.style.display = 'none';
  document.getElementById('gd-count').textContent = gdRawData.length;
  // gd-showing / gd-total were in the footer (removed) — guard with null check
  const showEl = document.getElementById('gd-showing');
  const totEl  = document.getElementById('gd-total');
  if (showEl) showEl.textContent = gdFiltered.length;
  if (totEl)  totEl.textContent  = gdRawData.length;

  if (gdFiltered.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }

  empty.style.display = 'none';
  table.style.display = 'table';

  // cols: 0=TEAMLEADER, 1=ASESORES, 2=PEROP1AM, 3=PAIS, 4=DESCANSO, 5=HORARIO, 6=EMPRESA
  tbody.innerHTML = gdFiltered.map(r => `
    <tr>
      <td><strong>${escapeHtml(r[0]) || '—'}</strong></td>
      <td>${escapeHtml(r[1]) || '—'}</td>
      <td>${gdPeropBadge(r[2])}</td>
      <td>${gdCountryBadge(r[3])}</td>
      <td>${gdDayBadge(r[4])}</td>
      <td>${gdScheduleBadge(r[5])}</td>
      <td>${gdEmpresaBadge(r[6])}</td>
      <td>${attBadge(r[7])}</td>
    </tr>`).join('');
}

/* Sort GoodDay table */
function sortGD(col) {
  gdSortDir[col] = !gdSortDir[col];
  gdFiltered.sort((a, b) => {
    const va = a[col] || '';
    const vb = b[col] || '';
    const na = parseFloat(va), nb = parseFloat(vb);
    if (!isNaN(na) && !isNaN(nb)) return gdSortDir[col] ? na - nb : nb - na;
    return gdSortDir[col] ? va.localeCompare(vb) : vb.localeCompare(va);
  });
  // update sort icons
  document.querySelectorAll('#gd-table thead th').forEach((th, i) => {
    th.classList.toggle('sorted', i === col);
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = i === col ? (gdSortDir[col] ? '↑' : '↓') : '↕';
  });
  renderGDTable();
}
