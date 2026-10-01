/* Vista Actualización de Data — centro de carga (solo Supervisores). Depende de goodday.js, ops.js y tl.js. */

/* ══════════════════════════════
   ACTUALIZACIÓN DE DATA — centro de carga (solo Supervisores)
   Centraliza los uploads de Excel que antes vivían dentro de cada sección
   (GoodDay y Approve Stats), más un link de referencia por sección.
══════════════════════════════ */
let dataUpdateLoaded = false;
let dataLinksMap = {}; // { section_key: { section_key, url, updated_at, updated_by } }

const DATA_SECTIONS = [
  {
    key: 'goodday',
    label: 'Equipos 360 — Distribución de Agentes (GoodDay)',
    hint: 'Excel, CSV o TSV con: TEAMLEADER, ASESORES, PEROP1AM, PAIS, DESCANSO, HORARIO, EMPRESA, ASISTENCIA (las columnas "IGNORAR" no se guardan)',
    table: 'dt_dis',
    parseWorkbook: gdParseWorkbook,
    deleteAll: gdDeleteAllCurrent,
    fetchLastUpload: gdFetchLastUpload,
    afterUpload: () => loadGoodDay(),
  },
  {
    key: 'ops',
    label: 'Approve Stats — Rendimiento por País',
    hint: 'Excel del reporte BI-04 — debe incluir columnas Operator y Country (el resto se guarda tal cual)',
    table: 'dt_ops',
    parseWorkbook: opsParseWorkbook,
    deleteAll: opsDeleteAllCurrent,
    fetchLastUpload: opsFetchLastUpload,
    afterUpload: () => loadOps(),
  },
  {
    key: 'tl',
    label: 'Top Team Leader — Rendimiento Mensual',
    hint: 'Excel con: Team Leader, All calls - Unique Orders, Call resulting statuses - Approve (+ el resto del reporte, se guarda tal cual)',
    table: 'dt_tl_stats',
    parseWorkbook: tlParseWorkbook,
    deleteAll: tlDeleteAllCurrent,
    fetchLastUpload: tlFetchLastUpload,
    // Cada carga guarda sola un punto en la evolución (si la data cambió). Devuelve un texto para el "✓ Listo".
    afterUpload: async () => { await loadTlStats(); return tlAutoSaveSnapshot(); },
  },
  // Hojas de errores de Equipos 360: se leen EN VIVO desde Google Sheets — solo se guarda el link
  // (sirve el link "Publicar en la web" tal cual, pubhtml; ver js/core/errors.js)
  ...ERR_SOURCES.map(s => ({
    key: s.linkKey,
    label: `Equipos 360 — ${s.full}`,
    hint: 'Hoja de Google publicada en la web: se lee en vivo, no se sube Excel. Si no hay link guardado se usa el de por defecto.',
    linkOnly: true,
    defaultUrl: s.defaultUrl,
  })),
  // Ventas por Fuera: una hoja por campaña, también en vivo (ver js/views/ventasfuera.js)
  ...VF_SOURCES.map(s => ({
    key: s.linkKey,
    label: `Ventas por Fuera — ${s.label}`,
    hint: 'Hoja de Google publicada en la web (Archivo → Compartir → Publicar en la web): se lee en vivo. Si no hay link guardado se usa el de por defecto.',
    linkOnly: true,
    defaultUrl: s.defaultUrl,
  })),
];

async function loadDataUpdateView() {
  dataUpdateLoaded = true;
  try {
    const [linkRows, ...lastUploads] = await Promise.all([
      sbFetch('dt_data_links', 'select=*'),
      ...DATA_SECTIONS.map(s => s.linkOnly ? Promise.resolve(null) : s.fetchLastUpload()),
    ]);
    dataLinksMap = {};
    (linkRows || []).forEach(r => { dataLinksMap[r.section_key] = r; });
    DATA_SECTIONS.forEach((s, i) => { s._lastUpload = lastUploads[i]; });
    renderDataUpdateTable();
  } catch (err) {
    console.error('Error cargando Actualización de Data:', err);
    document.getElementById('data-update-tbody').innerHTML =
      `<tr><td colspan="4" class="td-empty td-error">No se pudo cargar esta sección, intenta de nuevo.</td></tr>`;
  }
}

function dataFmtDate(iso) {
  if (!iso) return 'Sin datos todavía';
  const d = new Date(iso);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
}

function renderDataUpdateTable() {
  const tbody = document.getElementById('data-update-tbody');
  tbody.innerHTML = DATA_SECTIONS.map(s => {
    const link = dataLinksMap[s.key];
    const url = (link && link.url) || s.defaultUrl;
    const linkCell = url
      ? `<a class="data-link" href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener">🔗 Abrir enlace${link && link.url ? '' : ' (por defecto)'}</a>
         <button class="btn btn-ghost btn-sm" onclick="dataLinkEdit('${s.key}')" title="Cambiar link">✎ Cambiar</button>`
      : `<button class="btn btn-ghost btn-sm" onclick="dataLinkEdit('${s.key}')">+ Configurar link</button>`;

    const labelCell = `<td>
        <div class="data-label">${s.label}</div>
        <div class="data-hint">${s.hint}</div>
      </td>`;

    if (s.linkOnly) {
      return `<tr>
      ${labelCell}
      <td class="nowrap"><span class="ol-live"><span class="ol-live-dot"></span>En vivo</span></td>
      <td class="nowrap">${linkCell}</td>
      <td class="nowrap data-live-note">Se lee sola, no se sube nada</td>
    </tr>`;
    }

    return `<tr>
      ${labelCell}
      <td class="nowrap data-date">${dataFmtDate(s._lastUpload)}</td>
      <td class="nowrap">${linkCell}</td>
      <td class="nowrap">
        <span id="data-status-${s.key}" class="data-status"></span>
        <label class="btn btn-primary btn-sm cursor-pointer m-0" for="data-file-${s.key}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
          Subir Excel
        </label>
        <input type="file" id="data-file-${s.key}" accept=".xlsx,.xls,.csv,.tsv,.txt" hidden onchange="dataSectionFileSelected(event,'${s.key}')"/>
      </td>
    </tr>`;
  }).join('');
}

/* Guarda/reemplaza el link de referencia de una sección — confirma antes de pisar uno existente */
async function dataLinkEdit(sectionKey, customLabel) {
  if (!can('datalinks.edit')) return;
  const section = DATA_SECTIONS.find(s => s.key === sectionKey);
  const label = customLabel || (section && section.label) || sectionKey;
  const current = (dataLinksMap[sectionKey] && dataLinksMap[sectionKey].url) || '';

  const next = await uiPrompt(`Pega el link de datos para "${label}".`, {
    title: 'Link de Data', defaultValue: current, inputType: 'url', placeholder: 'https://…',
    validate: v => safeUrl(v) === '#' ? 'El link debe empezar con http:// o https://' : null,
  });
  if (next === null) return;
  const trimmed = next.trim();

  if (current && current !== trimmed) {
    const ok = await uiConfirm(`Ya hay un link guardado para "${label}".\n\nActual: ${current}\nNuevo: ${trimmed}`, {
      title: '¿Reemplazar el link?', confirmText: 'Reemplazar',
    });
    if (!ok) return;
  }

  try {
    const user = getCurrentUser();
    const res = await fetch(`${SB_URL}/rest/v1/dt_data_links?on_conflict=section_key`, {
      method: 'POST',
      headers: { ...SB_HEADERS, 'Content-Type': 'application/json', 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify([{ section_key: sectionKey, url: trimmed, updated_by: user ? user[0] : null, updated_at: new Date().toISOString() }]),
    });
    if (!res.ok) throw new Error(`Supabase upsert error ${res.status}`);
    const rows = await res.json();
    dataLinksMap[sectionKey] = rows[0];
    errOnLinkChanged(sectionKey);   // si es una hoja de errores, la próxima lectura usa el link nuevo
    vfOnLinkChanged(sectionKey);    // si es una hoja de Ventas por Fuera, se vuelve a leer con el link nuevo
    renderDataUpdateTable();
  } catch (err) {
    console.error('Error guardando link:', err);
    uiAlert('No se pudo guardar el link, intenta de nuevo.', { title: 'Error', tone: 'danger' });
  }
}

/* Handler genérico de subida: reemplaza toda la tabla de la sección con el Excel pegado */
async function dataSectionFileSelected(event, sectionKey) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !can('data.upload')) return;

  const section = DATA_SECTIONS.find(s => s.key === sectionKey);
  const status = document.getElementById(`data-status-${sectionKey}`);
  status.style.color = 'var(--text-light)';
  status.textContent = 'Leyendo archivo...';

  try {
    const buf = await file.arrayBuffer();
    // codepage:65001 (UTF-8) evita que los acentos/ñ de un .csv salgan corruptos ("Ã")
    const wb = XLSX.read(buf, { type: 'array', codepage: 65001 });
    const parsed = section.parseWorkbook(wb);
    if (parsed.length === 0) {
      status.style.color = 'var(--red)';
      status.textContent = 'No encontré filas válidas — revisa que los encabezados del Excel coincidan.';
      return;
    }

    status.textContent = `Guardando ${parsed.length} filas...`;
    await section.deleteAll();
    await bulkInsert(section.table, parsed);
    const extraNote = await section.afterUpload();   // algunas secciones devuelven un aviso extra (ej. Top TL)
    section._lastUpload = await section.fetchLastUpload();

    // renderDataUpdateTable() reconstruye la fila (incluida esta misma etiqueta de status) —
    // hay que reescribir el mensaje de éxito DESPUÉS de re-renderizar, sobre el elemento nuevo
    renderDataUpdateTable();
    const doneStatus = document.getElementById(`data-status-${sectionKey}`);
    if (doneStatus) {
      doneStatus.style.color = 'var(--green)';
      doneStatus.textContent = `✓ Listo — ${parsed.length} filas cargadas${typeof extraNote === 'string' && extraNote ? ` · ${extraNote}` : ''}`;
      setTimeout(() => { doneStatus.textContent = ''; }, 8000);
    }
  } catch (err) {
    console.error(`Error subiendo Excel de ${sectionKey}:`, err);
    status.style.color = 'var(--red)';
    status.textContent = (err && err.message) ? err.message : 'Error al procesar el archivo, intenta de nuevo.';
    status.title = status.textContent;
  }
}
