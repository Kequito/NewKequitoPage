/* Vista Stats OPs Today — avance de operadores durante la jornada. */

/* ══════════════════════════════
   STATS OPS TODAY — avance individual de operadores a lo largo de la jornada.
   Carga propia (no pasa por "Actualización de Data"): cada Excel subido reemplaza
   dt_ops_today por completo, pero ANTES de reemplazarlo se archiva el estado previo
   en dt_ops_today_history — así "desde la última actualización" y la evolución en
   el tiempo salen solas, sin necesidad de un botón de "Guardar" aparte.
   Reutiliza opsParseWorkbook/opsCoerceValue (genéricos, ya sirven para Operator+Country).
══════════════════════════════ */
let otLoaded = false;
let otDisIndex = {};            // PEROP1AM -> {teamLeader, asesor, horario}
let otCountryIndex = {};        // country -> [{operator, teamLeader, asesor, horario, uniqueOrders, approve, reject, trash}] desc por approve
let otCurrentByOperator = [];   // suma por operador (todas sus campañas) + deltas vs último snapshot, solo los que están en GoodDay
let otExpandedOperators = new Set();
let otRawRowsToday = [];        // dt_ops_today sin filtrar por campaña, para poder alternar el switch sin recargar
let otPrevMap = {};             // operator -> snapshot anterior (deltas), independiente de la campaña
let otCampaignMode = 'normal';  // 'normal' (Aray, Adcombo) | 'postsale' — se distinguen solo por el horario
let otRecallsByOperator = {};   // PEROP1AM -> [fila de dt_recalls] — directo de "Órdenes Actuales" en Gestión de Recalls
let otRecallsPopupOperator = null; // operador cuyo mini menú de Recalls está abierto (null = cerrado)

/* El único horario de Post-Sale es 09:00-18:00 (mismo criterio parcial que gdScheduleBadge/SCHEDULE_COLORS) */
function otIsPostSaleHorario(horario) {
  return (horario || '').includes('09:00');
}

/* Suma por operador a través de sus campañas — se usa tanto para la vista actual
   como para armar el snapshot que se archiva antes de cada carga nueva. */
function otAggregateByOperator(rawRows) {
  const map = {};
  (rawRows || []).forEach(r => {
    const operator = (r.Operator || '').trim();
    const country  = (r.Country || '').trim();
    if (!operator || !country) return;
    if (!map[operator]) map[operator] = { operator, uniqueOrders: 0, approve: 0, reject: 0, trash: 0, byCountry: [] };
    const uniqueOrders = Number(r['All calls - Unique Orders']) || 0;
    const approve = Number(r['Call resulting statuses - Approve']) || 0;
    const reject  = Number(r['Call resulting statuses - Reject']) || 0;
    const trash   = Number(r['Call resulting statuses - Trash']) || 0;
    map[operator].uniqueOrders += uniqueOrders;
    map[operator].approve += approve;
    map[operator].reject += reject;
    map[operator].trash += trash;
    map[operator].byCountry.push({ country, uniqueOrders, approve, reject, trash });
  });
  return Object.values(map);
}

/* Índice por país — usa datos SOLO de esa campaña (no totales), para el carrusel */
function otBuildCountryIndex(rawRows) {
  const map = {};
  (rawRows || []).forEach(r => {
    const operator = (r.Operator || '').trim();
    const country  = (r.Country || '').trim();
    if (!operator || !country) return;
    const dis = otDisIndex[operator];
    if (!dis) return; // debe estar en GoodDay
    if (!map[country]) map[country] = [];
    map[country].push({
      operator, teamLeader: dis.teamLeader, asesor: dis.asesor, horario: dis.horario,
      uniqueOrders: Number(r['All calls - Unique Orders']) || 0,
      approve: Number(r['Call resulting statuses - Approve']) || 0,
      reject: Number(r['Call resulting statuses - Reject']) || 0,
      trash: Number(r['Call resulting statuses - Trash']) || 0,
    });
  });
  Object.keys(map).forEach(c => map[c].sort((a, b) => b.approve - a.approve));
  return map;
}

async function otFetchLastUpload() {
  try {
    const rows = await sbFetch('dt_ops_today', 'select=uploaded_at,uploaded_by&order=uploaded_at.desc&limit=1');
    return (rows && rows.length > 0) ? rows[0] : null;
  } catch (err) {
    console.error('Error obteniendo fecha de carga de dt_ops_today:', err);
    return null;
  }
}

/* Recalls de "Órdenes Actuales" (dt_recalls, la tabla de la izquierda en Gestión de
   Recalls) — directo, sin depender de que esa sección ya se haya visitado en la sesión. */
async function otFetchRecalls() {
  try {
    return await sbFetch('dt_recalls', 'select=id_in_cc,country,substatus,cc_comment,status_check,last_call_operator');
  } catch (err) {
    console.error('Error cargando Recalls para Stats OPs Today:', err);
    return [];
  }
}

/* Medianoche GMT-5 de "hoy", como instante UTC real — fijo, sin importar la zona
   horaria del navegador de quien esté viendo la página. */
function otTodayResetBoundaryUTC() {
  const GMT_OFFSET_HOURS = -5;
  const now = new Date();
  const shifted = new Date(now.getTime() + GMT_OFFSET_HOURS * 3600000);
  const y = shifted.getUTCFullYear(), m = shifted.getUTCMonth(), d = shifted.getUTCDate();
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - GMT_OFFSET_HOURS * 3600000);
}

/* Clave de "hora calendario" en GMT-5 (año-mes-día-hora) — dos timestamps con la misma
   clave cayeron dentro de la misma hora en punto, sin importar los minutos. */
function otHourBucketKey(iso) {
  const GMT_OFFSET_HOURS = -5;
  const d = new Date(new Date(iso).getTime() + GMT_OFFSET_HOURS * 3600000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}`;
}

/* La comparación ya no es "contra la carga inmediatamente anterior" sino "contra la
   última carga de la hora previa": si dos cargas caen dentro de la MISMA hora en punto
   (ej. 8:10 y 8:30) no se comparan entre sí — se sigue comparando contra la última carga
   de la hora anterior (ej. la de las 7:xx), hasta que se cruce a una hora distinta.
   Solo cuenta lo de HOY (GMT-5) — cada día arranca en blanco, sin borrar el historial real. */
async function otFetchLastSnapshot(currentUploadedAtIso) {
  try {
    const boundary = otTodayResetBoundaryUTC().toISOString();
    const rows = await sbFetch(
      'dt_ops_today_history',
      `select=created_at,snapshot_uploaded_at,rows&created_at=gte.${encodeURIComponent(boundary)}&order=created_at.desc&limit=200`
    );
    if (!rows || rows.length === 0) return null;
    if (!currentUploadedAtIso) return rows[0]; // sin referencia horaria, se usa el más reciente

    const currentBucket = otHourBucketKey(currentUploadedAtIso);
    const withTime = rows.map(r => ({ ...r, _effTime: r.snapshot_uploaded_at || r.created_at }));
    const earlier = withTime
      .filter(r => otHourBucketKey(r._effTime) !== currentBucket)
      .sort((a, b) => new Date(b._effTime) - new Date(a._effTime));
    return earlier.length > 0 ? earlier[0] : null;
  } catch (err) {
    console.error('Error obteniendo snapshot anterior de Stats OPs Today:', err);
    return null;
  }
}

async function otDeleteAllCurrent() {
  const res = await fetch(`${SB_URL}/rest/v1/dt_ops_today?Operator=not.is.null`, {
    method: 'DELETE', headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error(`Supabase delete error ${await acctErrorDetail(res)}`);
}

/* Guarda el estado ACTUAL (antes de sobreescribirlo) como un punto de historial —
   guarda también su propia hora de carga (snapshot_uploaded_at), porque created_at
   acá solo dice cuándo se archivó (o sea, cuándo llegó la carga SIGUIENTE), no cuándo
   esta data en particular quedó vigente. Esa hora es la que se usa para agrupar por hora. */
async function otArchiveCurrentAsSnapshot() {
  const current = await sbFetch('dt_ops_today', 'select=*');
  if (!current || current.length === 0) return; // nada que archivar en la primera carga del día
  const rows = otAggregateByOperator(current);
  const snapshotUploadedAt = (current[0] && current[0].uploaded_at) || new Date().toISOString();
  await sbInsert('dt_ops_today_history', [{ rows, snapshot_uploaded_at: snapshotUploadedAt }]);
}

let otBusy = false; // true durante la subida de Excel — el auto-refresh se salta el ciclo mientras tanto

async function otOnFileSelected(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !can('opstoday.upload')) return;

  const status = document.getElementById('ot-upload-status');
  status.style.color = 'var(--text-light)';
  status.textContent = 'Leyendo archivo...';
  otBusy = true;

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', codepage: 65001 });
    const parsed = opsParseWorkbook(wb);
    if (parsed.length === 0) {
      status.style.color = 'var(--red)';
      status.textContent = 'No encontré filas válidas — revisa que los encabezados del Excel coincidan.';
      return;
    }

    status.textContent = 'Guardando el estado anterior como snapshot...';
    await otArchiveCurrentAsSnapshot();

    const user = getCurrentUser();
    const uploadedAt = new Date().toISOString();
    const stamped = parsed.map(r => ({ ...r, uploaded_by: user ? user[0] : null, uploaded_at: uploadedAt }));

    status.textContent = `Guardando ${parsed.length} filas...`;
    await otDeleteAllCurrent();
    await bulkInsert('dt_ops_today', stamped);

    await loadOpsToday();
    status.style.color = 'var(--green)';
    status.textContent = `✓ Listo — ${parsed.length} filas cargadas`;
    setTimeout(() => { const el = document.getElementById('ot-upload-status'); if (el) el.textContent = ''; }, 6000);
  } catch (err) {
    console.error('Error subiendo Excel de Stats OPs Today:', err);
    status.style.color = 'var(--red)';
    status.textContent = (err && err.message) ? err.message : 'Error al procesar el archivo, intenta de nuevo.';
    status.title = status.textContent;
  } finally {
    otBusy = false;
  }
}

/* Caja azul de "última actualización" (mismo formato que Recalls/Reporte/Approve Stats) */
function otUpdateLastUploadLabel(row) {
  const box = document.getElementById('ot-lastupd-box');
  if (!row || !row.uploaded_by) { box.style.display = 'none'; return; }
  box.style.display = 'flex';
  document.getElementById('ot-lastupd-name').textContent = row.uploaded_by;
  const d = new Date(row.uploaded_at);
  document.getElementById('ot-lastupd-time').textContent =
    `${d.toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'})} · ${d.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}`;
}

/* Link de "Data" de Stats OPs Today — mismo mecanismo que Recalls (dt_data_links,
   section_key='opstoday'). Cualquiera con acceso puede abrirlo; solo Supervisor lo cambia. */
async function otFetchDataLink() {
  try {
    const rows = await sbFetch('dt_data_links', 'select=*&section_key=eq.opstoday');
    if (rows && rows[0]) dataLinksMap['opstoday'] = rows[0];
    else delete dataLinksMap['opstoday'];
  } catch (err) {
    console.error('Error cargando link de Data de Stats OPs Today:', err);
  }
}

function otRenderDataLinkBtn() {
  const btn = document.getElementById('ot-data-link-btn');
  const editBtn = document.getElementById('ot-data-edit-btn');
  if (!btn || !editBtn) return;
  const link = dataLinksMap['opstoday'];
  btn.href = safeUrl(link && link.url);
  editBtn.style.display = can('datalinks.edit') ? 'inline-flex' : 'none';
}

function otOpenDataLink(event) {
  const link = dataLinksMap['opstoday'];
  if (link && link.url) return true;
  event.preventDefault();
  if (can('datalinks.edit')) {
    otEditDataLink();
  } else {
    uiAlert('Aún no se ha configurado el link de Data — pide a un Supervisor que lo configure.', { title: 'Sin link de Data' });
  }
  return false;
}

async function otEditDataLink() {
  if (!can('datalinks.edit')) return;
  await dataLinkEdit('opstoday', 'Stats OPs Today');
  otRenderDataLinkBtn();
}

async function loadOpsToday(silent = false) {
  otLoaded = true;
  document.getElementById('ot-upload-wrap').style.display = can('opstoday.upload') ? 'flex' : 'none';
  // silent = refresco automático de fondo (ver autoRefreshTick): se salta el link de
  // Data porque casi nunca cambia, así el ciclo de sync solo pide lo que sí es volátil.
  if (!silent) {
    await otFetchDataLink();
    otRenderDataLinkBtn();
  }

  try {
    const [rawRows, disRows, lastUpload, recallsRows] = await Promise.all([
      sbFetch('dt_ops_today', 'select=*'),
      sbFetch('dt_dis', 'select=PEROP1AM,ASESORES,TEAMLEADER,HORARIO'),
      otFetchLastUpload(),
      otFetchRecalls(),
    ]);
    // La comparación por hora necesita saber a qué hora quedó la data ACTUAL antes de
    // buscar el snapshot anterior — por eso este fetch va después, no en el Promise.all.
    const lastSnap = await otFetchLastSnapshot(lastUpload ? lastUpload.uploaded_at : null);

    otDisIndex = {};
    disRows.forEach(r => {
      const p = (r.PEROP1AM || '').trim();
      if (!p) return;
      otDisIndex[p] = { teamLeader: r.TEAMLEADER || '—', asesor: r.ASESORES || '—', horario: r.HORARIO || '—' };
    });

    otRecallsByOperator = {};
    recallsRows.forEach(r => {
      const op = (r.last_call_operator || '').trim();
      if (!op) return;
      (otRecallsByOperator[op] = otRecallsByOperator[op] || []).push(r);
    });

    otRawRowsToday = rawRows;
    otPrevMap = {};
    if (lastSnap) (lastSnap.rows || []).forEach(r => { otPrevMap[r.operator] = r; });

    otUpdateLastUploadLabel(lastUpload);
    otApplyCampaignFilter();
  } catch (err) {
    console.error('Error cargando Stats OPs Today:', err);
  }
}

/* Recalcula todo (índices + las 5 vistas dependientes) a partir de otRawRowsToday
   filtrado por campaña — sin volver a pedir nada a Supabase, así el switch es instantáneo. */
function otApplyCampaignFilter() {
  const wantPostSale = otCampaignMode === 'postsale';
  const rows = (otRawRowsToday || []).filter(r => {
    const operator = (r.Operator || '').trim();
    const dis = otDisIndex[operator];
    if (!dis) return false; // debe estar en GoodDay
    return otIsPostSaleHorario(dis.horario) === wantPostSale;
  });

  otCountryIndex = otBuildCountryIndex(rows);

  otCurrentByOperator = otAggregateByOperator(rows).map(o => {
    const dis = otDisIndex[o.operator];
    // Sin snapshot previo (primera carga del día, u operador nuevo en el reparto) = se compara contra 0,
    // así se ve de cuánto a cuánto va cada uno en vez de dejar el delta en blanco.
    const prev = otPrevMap[o.operator] || { uniqueOrders: 0, approve: 0, reject: 0, trash: 0 };
    return {
      ...o,
      teamLeader: dis.teamLeader, asesor: dis.asesor, horario: dis.horario,
      approvePct: o.uniqueOrders > 0 ? (o.approve / o.uniqueOrders) * 100 : 0,
      deltaUniqueOrders: o.uniqueOrders - prev.uniqueOrders,
      deltaApprove: o.approve - prev.approve,
      deltaReject: o.reject - prev.reject,
      deltaTrash: o.trash - prev.trash,
      recallsCount: (otRecallsByOperator[o.operator] || []).length,
    };
  });
  otCurrentByOperator.sort((a, b) => b.approve - a.approve);

  const scopeEl = document.getElementById('ot-top5-scope');
  if (scopeEl) scopeEl.textContent = wantPostSale ? '(Post-Sale)' : '(Campaña Normal)';

  otRenderTeamLeaderFilter();
  otRenderTop5();
  otBuildCountryCarousel();
  otRenderHighlightBoxes();
  otRenderDetailTable();
  otPopulateHistoryOperatorSelect();
}

function otSetCampaignMode(mode) {
  if (otCampaignMode === mode) return;
  otCampaignMode = mode;
  document.querySelectorAll('.ot-campaign-btn').forEach(b => {
    const active = b.dataset.mode === mode;
    b.classList.toggle('btn-primary', active);
    b.classList.toggle('btn-ghost', !active);
  });
  otExpandedOperators.clear();
  otApplyCampaignFilter();
}

function otRenderTeamLeaderFilter() {
  const sel = document.getElementById('ot-f-tl');
  const prev = sel.value;
  const tls = [...new Set(otCurrentByOperator.map(o => o.teamLeader).filter(t => t && t !== '—'))].sort();
  sel.innerHTML = '<option value="">Todos</option>' + tls.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
  if (prev) sel.value = prev;
}

/* Recorta nombres largos a un ancho predecible — evita que un Team Leader con nombre
   largo haga crecer la fila y mueva el tamaño del carrusel al cambiar de campaña. */
function otTruncateName(name, maxLen) {
  const v = (name || '').trim();
  if (!v || v === '—') return v;
  return v.length > maxLen ? v.slice(0, maxLen - 1) + '…' : v;
}

const OT_TOP5_N = 7;

function otRenderTop5() {
  const box = document.getElementById('ot-top5');
  const top5 = [...otCurrentByOperator].sort((a, b) => b.approve - a.approve).slice(0, OT_TOP5_N);
  if (top5.length === 0) {
    box.innerHTML = `<div class="gd-state" style="padding:30px"><p>Sin datos todavía</p></div>`;
    return;
  }
  box.innerHTML = `
    <table>
      <thead><tr><th></th><th>Team Leader</th><th>Operador</th><th>País</th><th style="text-align:right">Ventas</th></tr></thead>
      <tbody>${top5.map((o, i) => `<tr>
        <td style="font-weight:700;color:var(--text-light)">${i + 1}</td>
        <td style="white-space:nowrap">${recTlBadge(otTruncateName(o.teamLeader, 18))}</td>
        <td style="font-weight:600"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px" title="${escapeHtml(o.asesor)}">${escapeHtml(o.asesor)}</div><div style="font-size:10px;color:var(--text-light);font-weight:400">${escapeHtml(o.operator)}</div></td>
        <td style="white-space:nowrap">${otCountryCellHTML(o)}</td>
        <td style="text-align:right;font-weight:800;font-size:19px;color:var(--green)">${o.approve.toLocaleString('es-PE')}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

/* ── Carrusel top 5 por campaña (mismo mecanismo que el de Inicio) ── */
let otTopOpsCountries = [];
let otTopOpsIndex = 0;
let otTopOpsTimer = null;
const OT_TOP_OPS_N = 5;
const OT_TOP_OPS_INTERVAL = 6000;

function otBuildCountryCarousel() {
  otTopOpsCountries = Object.keys(otCountryIndex).sort().map(country => ({
    country, rows: otCountryIndex[country].slice(0, OT_TOP_OPS_N),
  })).filter(x => x.rows.length > 0);
  if (otTopOpsIndex >= otTopOpsCountries.length) otTopOpsIndex = 0;
  otRenderTopOpsSlide();
  otResetTopOpsTimer();
}

function otRenderTopOpsSlide() {
  const wrap = document.getElementById('ot-top-ops-slide');
  const dots = document.getElementById('ot-top-ops-dots');
  if (otTopOpsCountries.length === 0) {
    wrap.innerHTML = `<div class="gd-state" style="padding:30px"><p>Sin datos todavía</p></div>`;
    dots.innerHTML = '';
    return;
  }
  const slide = otTopOpsCountries[otTopOpsIndex];
  const color = REP_COUNTRY_COLORS[slide.country] || REP_FALLBACK_COLORS[otTopOpsIndex % REP_FALLBACK_COLORS.length];
  const rowsHtml = slide.rows.map((r, i) => `<tr>
    <td style="font-weight:700;color:var(--text-light)">${i + 1}</td>
    <td style="font-weight:600"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px" title="${escapeHtml(r.asesor)}">${escapeHtml(r.asesor)}</div><div style="font-size:10px;color:var(--text-light);font-weight:400">${escapeHtml(r.operator)}</div></td>
    <td style="white-space:nowrap">${recTlBadge(otTruncateName(r.teamLeader, 15))}</td>
    <td style="text-align:right;font-weight:800;font-size:19px;color:var(--green)">${r.approve}</td>
  </tr>`).join('');
  wrap.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700;color:${color}">${countryFlag(slide.country)}${escapeHtml(slide.country)}</div>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead><tr><th></th><th>Operador</th><th>Team Leader</th><th style="text-align:right">Ventas</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
  dots.innerHTML = otTopOpsCountries.map((s, i) => `<span onclick="otTopOpsGoto(${i})" style="width:7px;height:7px;border-radius:50%;cursor:pointer;background:${i === otTopOpsIndex ? 'var(--nav-accent)' : 'var(--border)'};transition:background .2s"></span>`).join('');
}

function otTopOpsGoto(i) {
  if (otTopOpsCountries.length === 0) return;
  otTopOpsIndex = ((i % otTopOpsCountries.length) + otTopOpsCountries.length) % otTopOpsCountries.length;
  otRenderTopOpsSlide();
  otResetTopOpsTimer();
}
function otTopOpsNext() { otTopOpsGoto(otTopOpsIndex + 1); }
function otTopOpsPrev() { otTopOpsGoto(otTopOpsIndex - 1); }

function otStartProgressBar() {
  const fill = document.getElementById('ot-top-ops-progress-fill');
  if (!fill) return;
  fill.style.transition = 'none';
  fill.style.width = '0%';
  void fill.offsetWidth;
  fill.style.transition = `width ${OT_TOP_OPS_INTERVAL}ms linear`;
  fill.style.width = '100%';
}

function otResetTopOpsTimer() {
  if (otTopOpsTimer) clearInterval(otTopOpsTimer);
  const box = document.getElementById('ot-top-ops-progress');
  if (otTopOpsCountries.length > 1) {
    box.style.display = 'block';
    otStartProgressBar();
    otTopOpsTimer = setInterval(() => {
      otTopOpsIndex = (otTopOpsIndex + 1) % otTopOpsCountries.length;
      otRenderTopOpsSlide();
      otStartProgressBar();
    }, OT_TOP_OPS_INTERVAL);
  } else {
    box.style.display = 'none';
  }
}

/* ── 4 cajas de "mayor cambio desde la última actualización" (con empates) ── */
function otFindDeltaLeaders(key) {
  const withDelta = otCurrentByOperator.filter(o => o[key] !== null && o[key] !== undefined);
  if (withDelta.length === 0) return { max: 0, leaders: [] };
  const max = Math.max(...withDelta.map(o => o[key]));
  if (max <= 0) return { max, leaders: [] };
  return { max, leaders: withDelta.filter(o => o[key] === max) };
}

function otRenderHighlightBoxes() {
  const specs = [
    { key: 'deltaApprove',      elId: 'ot-hl-approve', color: '#16a34a' },
    { key: 'deltaReject',       elId: 'ot-hl-reject',  color: '#dc2626' },
    { key: 'deltaTrash',        elId: 'ot-hl-trash',   color: '#b45309' },
    { key: 'deltaUniqueOrders', elId: 'ot-hl-orders',  color: '#475569' },
  ];
  specs.forEach(s => {
    const el = document.getElementById(s.elId);
    const { max, leaders } = otFindDeltaLeaders(s.key);
    if (leaders.length === 0) {
      el.innerHTML = `<div style="font-size:11px;color:var(--text-light)">Sin cambios todavía</div>`;
      return;
    }
    el.innerHTML = leaders.map(o => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0">
        <span style="font-size:13px;font-weight:600">${escapeHtml(o.asesor)}<span style="color:var(--text-light);font-weight:400;font-size:10.5px"> · ${escapeHtml(o.operator)}</span></span>
        <span style="font-weight:800;font-size:24px;white-space:nowrap;color:${s.color}">+${max}</span>
      </div>`).join('');
  });
}

/* ── Parte 2: tabla de detalle, con sub-filas desplegables por campaña ── */
/* Color fijo por métrica (no por dirección) — mismo esquema que las 4 cajas de arriba:
   ventas=verde, reject=rojo, trash=amarillo, órdenes únicas=gris. */
const OT_METRIC_COLORS = {
  approve:      { color: '#16a34a', bg: 'rgba(22,163,74,.10)' },
  reject:       { color: '#dc2626', bg: 'rgba(220,38,38,.10)' },
  trash:        { color: '#b45309', bg: 'rgba(180,83,9,.10)' },
  uniqueOrders: { color: '#475569', bg: 'rgba(71,85,105,.08)' },
};

function otDeltaHTML(delta, metric) {
  if (delta === null || delta === undefined) return '';
  const c = OT_METRIC_COLORS[metric] || OT_METRIC_COLORS.uniqueOrders;
  if (delta === 0) {
    return `<span style="display:inline-block;padding:1px 6px;border-radius:5px;font-size:10.5px;font-weight:700;background:var(--card-bg-2);border:1px solid var(--border);color:var(--text-light)">→ 0</span>`;
  }
  const up = delta > 0;
  // Son cantidades acumuladas del día — casi siempre suben, así que el "+" ya lo dice todo
  // sin necesidad de flecha; solo se marca con ▼ el caso raro de una baja.
  return `<span style="display:inline-block;padding:1px 7px;border-radius:5px;font-size:12px;font-weight:800;background:${c.bg};border:1px solid ${c.color}66;color:${c.color}">${up ? '' : '▼'}${up ? '+' : ''}${delta}</span>`;
}

/* Bandera(s) + país(es) que maneja el operador — una si solo trabaja una campaña, todas si trabaja varias */
function otCountryCellHTML(o) {
  return o.byCountry.map(c => `${countryFlag(c.country)}${escapeHtml(c.country)}`).join(', ');
}

function otToggleExpand(operator) {
  if (otExpandedOperators.has(operator)) otExpandedOperators.delete(operator);
  else otExpandedOperators.add(operator);
  otRenderDetailTable();
}

/* Mini menú flotante con los Recalls de un operador — un solo elemento reusado para
   toda la tabla (no uno por fila), posicionado junto al botón que lo abrió. La lista
   sale directo de "Órdenes Actuales" (dt_recalls) vía otRecallsByOperator. */
function otShowRecallsPopup(event, operator) {
  event.stopPropagation();
  const popup = document.getElementById('ot-recalls-popup');
  if (otRecallsPopupOperator === operator && popup.style.display === 'block') {
    otHideRecallsPopup();
    return;
  }
  const rows = otRecallsByOperator[operator] || [];
  const dis = otDisIndex[operator] || {};
  const itemsHtml = rows.map(r => {
    const cls = recStatusColorClass(r.status_check);
    const dot = cls === 'rec-status-red' ? 'var(--red)' : cls === 'rec-status-yellow' ? 'var(--amber)' : 'var(--border)';
    return `<div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:flex-start">
      <span style="width:7px;height:7px;border-radius:50%;background:${dot};flex-shrink:0;margin-top:5px"></span>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:700;white-space:nowrap">${escapeHtml(r.id_in_cc) || '—'} <span style="font-weight:400;color:var(--text-light)">${countryFlag(r.country)}${escapeHtml(r.country)}</span></div>
        <div style="font-size:11.5px;color:var(--text-mid)">${escapeHtml(r.substatus) || '—'}</div>
        ${r.cc_comment ? `<div style="font-size:11px;color:var(--text-light);margin-top:2px">${escapeHtml(r.cc_comment)}</div>` : ''}
      </div>
      ${r.id_in_cc ? `<button class="btn btn-ghost btn-sm rec-link-trigger" title="Abrir Change / View" onclick="recOpenLinkMenu(event,${jsArg(r.id_in_cc)})" style="padding:4px 6px;flex-shrink:0">
        <svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
        <svg viewBox="0 0 24 24" fill="currentColor" style="width:10px;height:10px;margin-left:1px"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
      </button>` : ''}
    </div>`;
  }).join('') || `<div style="padding:16px;text-align:center;color:var(--text-light);font-size:12px">Sin recalls</div>`;

  popup.innerHTML = `
    <div style="padding:12px 14px;border-bottom:1px solid var(--border);background:var(--main-bg);position:sticky;top:0">
      <div style="font-size:13px;font-weight:700">${escapeHtml(dis.asesor || operator)}</div>
      <div style="font-size:10px;color:var(--text-light)">${escapeHtml(operator)} · ${rows.length} recall${rows.length === 1 ? '' : 's'}</div>
    </div>
    <div>${itemsHtml}</div>
  `;

  popup.style.display = 'block';
  const btn = event.currentTarget;
  const rect = btn.getBoundingClientRect();
  const popupWidth = popup.offsetWidth || 380;
  const popupHeight = popup.offsetHeight || 300;
  let left = rect.left;
  if (left + popupWidth > window.innerWidth - 12) left = window.innerWidth - popupWidth - 12;
  popup.style.left = `${Math.max(8, left)}px`;

  const spaceBelow = window.innerHeight - rect.bottom - 12;
  const top = (popupHeight > spaceBelow && rect.top - popupHeight - 6 > 8)
    ? rect.top - popupHeight - 6
    : Math.min(rect.bottom + 6, window.innerHeight - popupHeight - 12);
  popup.style.top = `${Math.max(8, top)}px`;

  otRecallsPopupOperator = operator;
}

function otHideRecallsPopup() {
  const popup = document.getElementById('ot-recalls-popup');
  if (popup) popup.style.display = 'none';
  otRecallsPopupOperator = null;
}

document.addEventListener('click', (e) => {
  const popup = document.getElementById('ot-recalls-popup');
  if (!popup || popup.style.display === 'none' || popup.contains(e.target)) return;
  otHideRecallsPopup();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') otHideRecallsPopup(); });

/* Fondo degradado por RANKING de valores distintos (no por posición lineal entre min y
   max) — así el primer lugar siempre se ve claramente más fuerte que el resto, incluso
   cuando varios operadores tienen valores parecidos agrupados hacia arriba. Alpha amplio
   + texto claro del tema oscuro (--text-dark) para que el número se distinga siempre. */
function otBuildRankMap(vals) {
  const uniqueSorted = [...new Set(vals)].sort((a, b) => a - b);
  const map = new Map();
  const n = uniqueSorted.length;
  uniqueSorted.forEach((v, i) => map.set(v, n > 1 ? i / (n - 1) : 1));
  return map;
}
function otHeatBg(value, rankMap, rgb) {
  if (!isFinite(value) || !rankMap || rankMap.size <= 1) return '';
  const t = rankMap.get(value);
  if (t === undefined) return '';
  const alpha = (0.06 + t * 0.42).toFixed(3);
  return `background:rgba(${rgb},${alpha});`;
}

/* Orden de columnas en #ot-table — null = no ordenable (toggle expandir, País es multi-valor) */
const OT_SORT_KEYS = [null, 'teamLeader', 'asesor', null, 'horario', 'recallsCount', 'uniqueOrders', 'approve', 'reject', 'trash'];
let otSortCol = null;
let otSortDir = {};

function otSortTable(col) {
  const key = OT_SORT_KEYS[col];
  if (!key) return;
  otSortDir[col] = !otSortDir[col];
  otSortCol = col;
  otCurrentByOperator.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'string') {
      return otSortDir[col] ? va.localeCompare(vb) : vb.localeCompare(va);
    }
    return otSortDir[col] ? va - vb : vb - va;
  });
  document.querySelectorAll('#ot-table thead th').forEach((th, i) => {
    th.classList.toggle('sorted', i === col);
    const icon = th.querySelector('.sort-icon');
    if (icon) icon.textContent = i === col ? (otSortDir[col] ? '↑' : '↓') : '↕';
  });
  otRenderDetailTable();
}

function otRenderDetailTable() {
  otHideRecallsPopup(); // el tbody se reconstruye entero — un popup abierto quedaría apuntando a un botón que ya no existe
  const table = document.getElementById('ot-table');
  const empty = document.getElementById('ot-detail-empty');
  const tbody = document.getElementById('ot-tbody');
  const tlFilter = document.getElementById('ot-f-tl').value;

  const filtered = otCurrentByOperator.filter(o => !tlFilter || o.teamLeader === tlFilter);
  document.getElementById('ot-detail-count').textContent = `(${filtered.length})`;

  if (filtered.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  table.style.display = 'table';

  const uoRank = otBuildRankMap(filtered.map(o => o.uniqueOrders));
  const apRank = otBuildRankMap(filtered.map(o => o.approve));
  const rjRank = otBuildRankMap(filtered.map(o => o.reject));
  const trRank = otBuildRankMap(filtered.map(o => o.trash));

  tbody.innerHTML = filtered.map(o => {
    const multi = o.byCountry.length > 1;
    const expanded = otExpandedOperators.has(o.operator);
    const opArg = jsArg(o.operator);
    const toggleCell = multi
      ? `<button class="btn btn-ghost btn-sm" onclick="otToggleExpand(${opArg})" style="padding:2px 8px">${expanded ? '▾' : '▸'}</button>`
      : '';

    const recallsCount = o.recallsCount || 0;
    const recallsCell = recallsCount > 0
      ? `<button class="btn btn-ghost btn-sm" onclick="otShowRecallsPopup(event,${opArg})" style="white-space:nowrap;font-weight:700;color:var(--nav-accent)">🔁 ${recallsCount}</button>`
      : `<span style="color:var(--text-light);font-size:12px">—</span>`;

    const mainRow = `<tr>
      <td>${toggleCell}</td>
      <td>${recTlBadge(o.teamLeader)}</td>
      <td>${escapeHtml(o.asesor)}<div style="font-size:10px;color:var(--text-light)">${escapeHtml(o.operator)}</div></td>
      <td style="white-space:nowrap">${otCountryCellHTML(o)}</td>
      <td>${gdScheduleBadge(o.horario)}</td>
      <td>${recallsCell}</td>
      <td style="white-space:nowrap;font-size:16px;font-weight:700;${otHeatBg(o.uniqueOrders, uoRank, '156,168,181')}">${o.uniqueOrders} ${otDeltaHTML(o.deltaUniqueOrders, 'uniqueOrders')}</td>
      <td style="white-space:nowrap;font-size:17px;font-weight:800;color:var(--green);${otHeatBg(o.approve, apRank, '34,197,94')}">${o.approve} ${otDeltaHTML(o.deltaApprove, 'approve')}</td>
      <td style="white-space:nowrap;font-size:16px;font-weight:700;${otHeatBg(o.reject, rjRank, '240,96,92')}">${o.reject} ${otDeltaHTML(o.deltaReject, 'reject')}</td>
      <td style="white-space:nowrap;font-size:16px;font-weight:700;${otHeatBg(o.trash, trRank, '240,178,62')}">${o.trash} ${otDeltaHTML(o.deltaTrash, 'trash')}</td>
    </tr>`;

    if (!multi || !expanded) return mainRow;

    const subRows = o.byCountry.map(c => {
      return `<tr style="background:rgba(16,24,20,.025)">
        <td></td>
        <td></td>
        <td></td>
        <td style="color:var(--text-light);font-size:12px;white-space:nowrap">${countryFlag(c.country)}${escapeHtml(c.country)}</td>
        <td></td>
        <td></td>
        <td>${c.uniqueOrders}</td>
        <td style="font-weight:700">${c.approve}</td>
        <td>${c.reject}</td>
        <td>${c.trash}</td>
      </tr>`;
    }).join('');
    return mainRow + subRows;
  }).join('');
}

/* ── Evolución por operador ── */
const OT_METRIC_LABELS = { approve: 'Ventas (Approve)', uniqueOrders: 'Órdenes Únicas', reject: 'Reject', trash: 'Trash' };
let otHistoryMetric   = 'approve';
let otHistoryOperator = '';
let otHistoryDateFilter = 'today';
let otHistorySnapshots  = [];
let otHistoryChartInstance = null;

/* La lista sale de TODO GoodDay, no solo de quien tiene stats hoy — si el OP faltó o
   descansó y no tiene data, su evolución simplemente se ve en blanco al seleccionarlo. */
function otPopulateHistoryOperatorSelect() {
  const sel = document.getElementById('ot-hist-operator');
  const prev = sel.value;
  const wantPostSale = otCampaignMode === 'postsale';
  const all = Object.keys(otDisIndex)
    .filter(perop => otIsPostSaleHorario(otDisIndex[perop].horario) === wantPostSale)
    .map(perop => ({ operator: perop, asesor: otDisIndex[perop].asesor }));
  all.sort((a, b) => a.asesor.localeCompare(b.asesor));
  sel.innerHTML = '<option value="">Selecciona un operador…</option>' +
    all.map(o => `<option value="${escapeHtml(o.operator)}">${escapeHtml(o.asesor)} (${escapeHtml(o.operator)})</option>`).join('');
  if (prev && all.some(o => o.operator === prev)) {
    sel.value = prev;
  } else if (sel.value) {
    sel.value = '';
    otLoadHistoryChart();
  }
}

function otHistLocalDayStart(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

function otHistDateBoundsFor(filter) {
  if (filter === 'today') { const start = otHistLocalDayStart(0); const end = otHistLocalDayStart(1); return { start, end }; }
  if (filter === 'yesterday') { const start = otHistLocalDayStart(-1); const end = otHistLocalDayStart(0); return { start, end }; }
  if (filter === '7d') { const end = new Date(); const start = new Date(); start.setDate(start.getDate() - 7); return { start, end }; }
  return null; // 'all'
}

function otSetHistDateFilter(value) {
  otHistoryDateFilter = value;
  document.querySelectorAll('.ot-date-btn').forEach(b => {
    const active = b.dataset.filter === value;
    b.classList.toggle('btn-primary', active);
    b.classList.toggle('btn-ghost', !active);
  });
  otLoadHistoryChart();
}

function otSelectHistoryMetric(metric) {
  otHistoryMetric = metric;
  document.querySelectorAll('.ot-metric-btn').forEach(b => {
    const active = b.dataset.metric === metric;
    b.classList.toggle('btn-primary', active);
    b.classList.toggle('btn-ghost', !active);
  });
  otRenderHistoryChart();
}

async function otLoadHistoryChart() {
  const operator = document.getElementById('ot-hist-operator').value;
  otHistoryOperator = operator;
  if (!operator) {
    otHistorySnapshots = [];
    otRenderHistoryChart();
    return;
  }
  try {
    const bounds = otHistDateBoundsFor(otHistoryDateFilter);
    let query = 'select=created_at,rows&order=created_at.asc&limit=500';
    if (bounds) {
      query += `&created_at=gte.${encodeURIComponent(bounds.start.toISOString())}`;
      query += `&created_at=lt.${encodeURIComponent(bounds.end.toISOString())}`;
    }
    otHistorySnapshots = await sbFetch('dt_ops_today_history', query);
  } catch (err) {
    console.error('Error cargando evolución del operador:', err);
    otHistorySnapshots = [];
  }
  otRenderHistoryChart();
}

function otRenderHistoryChart() {
  const canvas = document.getElementById('otHistChart');
  const emptyEl = document.getElementById('ot-hist-chart-empty');
  const wrapEl = document.getElementById('ot-hist-chart-wrap');
  if (otHistoryChartInstance) { otHistoryChartInstance.destroy(); otHistoryChartInstance = null; }

  const operator = otHistoryOperator;
  const currentRow = operator ? otCurrentByOperator.find(o => o.operator === operator) : null;

  // Solo se pide elegir un operador — si ya eligió uno pero no tiene data (faltó, descansó),
  // el gráfico se muestra igual, simplemente en blanco (sin barras).
  if (!operator) {
    emptyEl.style.display = 'flex';
    wrapEl.style.display = 'none';
    return;
  }
  emptyEl.style.display = 'none';
  wrapEl.style.display = 'block';

  const labels = otHistorySnapshots.map(s => {
    const d = new Date(s.created_at);
    return d.toLocaleString('es-PE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  });
  const values = otHistorySnapshots.map(s => {
    const row = (s.rows || []).find(r => r.operator === operator);
    return row ? (row[otHistoryMetric] || 0) : null;
  });
  // Punto "Ahora" — el estado actual todavía no archivado, para que se vea también el avance en vivo
  if (currentRow) {
    labels.push('Ahora');
    values.push(currentRow[otHistoryMetric] || 0);
  }

  otHistoryChartInstance = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: OT_METRIC_LABELS[otHistoryMetric],
        data: values,
        backgroundColor: '#4ade80',
        borderRadius: 4, borderSkipped: false,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        datalabels: {
          display: (ctx) => ctx.dataset.data[ctx.dataIndex] !== null && ctx.dataset.data[ctx.dataIndex] !== undefined,
          formatter: (value) => value,
          color: '#fff',
          textStrokeColor: 'rgba(0,0,0,.55)',
          textStrokeWidth: 3,
          font: { family: "'Lexend', sans-serif", weight: '700', size: 15 },
          anchor: 'center',
          align: 'center',
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { ...chartDefaults.font, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { grid: { color: CHART_GRID }, ticks: { ...chartDefaults.font }, beginAtZero: true },
      },
    },
  });
}
