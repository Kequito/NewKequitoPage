/* Vista Approve Stats — rendimiento por país / Team Leader (dt_ops). */

/* ══════════════════════════════
   OPS PERFORMANCE — Excel (Total + Approve %), como Recalls
══════════════════════════════ */
let opsDisData   = {};  // keyed by PEROP1AM → {ASESORES, TEAMLEADER, HORARIO, PAIS, CAMPANA}
let opsFiltered  = [];
let opsCountries = [];
let opsLoaded    = false;

/* Excel a veces guarda % como fracción (0.228) y a veces como número/texto ("22.8" o "22.8%") */
function opsParsePercent(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw === 'number') return raw <= 1 ? raw * 100 : raw;
  const n = parseFloat(String(raw).replace('%', '').trim());
  if (isNaN(n)) return 0;
  return n <= 1 ? n * 100 : n;
}

/* Convierte un valor crudo de Excel según el tipo de columna: % -> número 0-100, resto -> número */
function opsCoerceValue(header, raw) {
  if (header.toLowerCase().includes('%')) return opsParsePercent(raw);
  if (raw === null || raw === undefined || raw === '') return 0;
  if (typeof raw === 'number') return raw;
  const n = parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

/* Lee TODAS las columnas del Excel (23 en total), usando el texto exacto del encabezado
   como clave — así coincide 1 a 1 con las columnas de dt_ops sin tener que listarlas a mano */
function opsParseWorkbook(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (raw.length === 0) return [];

  const headers = Object.keys(raw[0]);
  const opKey = headers.find(h => recNormalizeHeader(h) === 'operator');
  const coKey = headers.find(h => recNormalizeHeader(h) === 'country');

  return raw.map(row => {
    const operator = opKey ? String(row[opKey] ?? '').trim() : '';
    const country  = coKey ? String(row[coKey] ?? '').trim() : '';
    if (!operator || !country) return null;

    const record = { 'Operator': operator, 'Country': country };
    headers.forEach(h => {
      if (h === opKey || h === coKey) return;
      record[h] = opsCoerceValue(h, row[h]);
    });
    return record;
  }).filter(Boolean);
}

async function opsDeleteAllCurrent() {
  const res = await fetch(`${SB_URL}/rest/v1/dt_ops?Operator=not.is.null`, {
    method: 'DELETE',
    headers: SB_HEADERS,
  });
  if (!res.ok) throw new Error(`Supabase delete error ${res.status}`);
}

const COUNTRY_CODES = {
  'CHILE':'cl','COLOMBIA':'co','ECUADOR':'ec','PERU':'pe','PERÚ':'pe',
  'MEXICO':'mx','MÉXICO':'mx','ARGENTINA':'ar','URUGUAY':'uy','BOLIVIA':'bo',
  'PARAGUAY':'py','VENEZUELA':'ve','COSTA RICA':'cr','PANAMA':'pa','PANAMÁ':'pa',
  'GUATEMALA':'gt','HONDURAS':'hn','NICARAGUA':'ni','EL SALVADOR':'sv',
  'ESPAÑA':'es','ESPANA':'es',
};

function countryFlag(country) {
  const code = COUNTRY_CODES[(country||'').toUpperCase().trim()];
  if (!code) return '';
  return `<img src="https://flagcdn.com/20x15/${code}.png" srcset="https://flagcdn.com/40x30/${code}.png 2x" width="20" height="15" alt="${country}" style="border-radius:2px;vertical-align:middle;margin-right:4px;box-shadow:0 1px 3px rgba(0,0,0,.2)">`;
}

// 8 países fijos que arma la pantalla de entrada — mismo set/orden que Reportes
const OPS_STATS_COUNTRIES = ['Chile', 'Colombia', 'Costa Rica', 'Ecuador', 'Mexico', 'Paraguay', 'Peru', 'Uruguay'];

/* Fecha real de la última carga (no la hora en que el usuario abrió la página) */
async function opsFetchLastUpload() {
  try {
    const rows = await sbFetch('dt_ops', 'select=uploaded_at&order=uploaded_at.desc&limit=1');
    return (rows && rows.length > 0) ? rows[0].uploaded_at : null;
  } catch (err) {
    console.error('Error obteniendo fecha de carga de dt_ops:', err);
    return null;
  }
}

/* El BI-04 siempre trae los últimos 90 días contados desde el momento de la carga */
function opsUpdateWindowBanner(uploadedAtIso) {
  const box = document.getElementById('ops-window-banner');
  const textEl = document.getElementById('ops-window-text');
  if (!uploadedAtIso) {
    box.style.display = 'none';
    return;
  }
  const end = new Date(uploadedAtIso);
  const start = new Date(end);
  start.setDate(start.getDate() - 90);
  const fmt = d => d.toLocaleDateString('es-ES', { day:'2-digit', month:'2-digit', year:'numeric' });
  textEl.textContent = `Estos datos son del reporte BI-04 de los últimos 90 días, contados desde la última vez que un Supervisor actualizó el reporte: del ${fmt(start)} al ${fmt(end)}.`;
  box.style.display = 'flex';
}

async function loadOps() {
  const picker = document.getElementById('ops-picker');
  picker.style.opacity = '.4';
  picker.style.pointerEvents = 'none';

  try {
    // Fetch all dt_ops rows, all dt_dis rows, y la fecha de la última carga
    const [opsData, disData, lastUpload] = await Promise.all([
      sbFetch('dt_ops', 'select=*&order=Operator.asc'),
      sbFetch('dt_dis', 'select=PEROP1AM,ASESORES,TEAMLEADER,HORARIO'),
      opsFetchLastUpload(),
    ]);

    // Index dt_ops por Operator+Country — guarda la fila completa (ya trae todas las columnas del Excel)
    const opsIdx = {};
    opsData.forEach(r => {
      const op = (r.Operator||'').trim(), co = (r.Country||'').trim();
      if (!op || !co) return;
      if (!opsIdx[op]) opsIdx[op] = {};
      opsIdx[op][co] = r;
    });

    // Index dt_dis by PEROP1AM
    opsDisData = {};
    disData.forEach(r => {
      const p = (r.PEROP1AM||'').trim();
      if (!p) return;
      if (!opsDisData[p]) {
        opsDisData[p] = { ASESORES: r.ASESORES||'—', TEAMLEADER: r.TEAMLEADER||'—', HORARIO: r.HORARIO||'—' };
      }
    });

    opsCountries = [...new Set(opsData.map(r=>(r.Country||'').trim()).filter(Boolean))].sort();
    window._opsIdx = opsIdx;
    opsLoaded = true;

    const box = document.getElementById('ops-lastupd-box');
    if (lastUpload) {
      const d = new Date(lastUpload);
      document.getElementById('ops-lastupd-time').textContent =
        `${d.toLocaleDateString('es-ES',{day:'2-digit',month:'2-digit',year:'numeric'})} · ${d.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})}`;
      box.style.display = 'flex';
    } else {
      box.style.display = 'none';
    }
    opsUpdateWindowBanner(lastUpload);

  } catch(err) {
    console.error('Error cargando Approve Stats:', err);
  } finally {
    picker.style.opacity = '';
    picker.style.pointerEvents = '';
  }

  opsRenderPickerCards();
  opsShowPicker();
}

/* Países en cuadrado 3x3 a la izquierda + Team Leaders individuales a la derecha —
   ambos entran directo al detalle (mismas funciones de siempre), solo cambia la presentación. */
function opsRenderPickerCards() {
  const countryWrap = document.getElementById('ops-picker-countries');
  countryWrap.innerHTML = OPS_STATS_COUNTRIES.map((c, i) => {
    const color = REP_COUNTRY_COLORS[c] || REP_FALLBACK_COLORS[i % REP_FALLBACK_COLORS.length];
    return `<div class="ops-pick-card" style="border-color:${color}55" onclick="opsShowCountryDetail('${c}')">
      ${countryFlag(c)}
      <div class="ops-pick-label" style="color:${color}">${c}</div>
    </div>`;
  }).join('');

  const tlWrap = document.getElementById('ops-picker-tls');
  const tls = [...new Set(Object.values(opsDisData).map(d => d.TEAMLEADER).filter(v => v && v !== '—'))].sort();
  if (tls.length === 0) {
    tlWrap.innerHTML = `<span style="color:var(--text-light);font-size:12px">No hay Team Leaders cargados todavía — revisa GoodDay.</span>`;
    return;
  }
  tlWrap.innerHTML = tls.map(tl => {
    const safe = tl.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    return `<div class="ops-pick-card" style="border-color:var(--nav-accent)55" onclick="opsSelectTeamLeader('${safe}')">
      <svg viewBox="0 0 24 24" fill="currentColor" style="width:22px;height:22px;color:var(--nav-accent)"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
      <div class="ops-pick-label" style="color:var(--nav-accent);text-align:center">${tl}</div>
    </div>`;
  }).join('');
}

function opsShowPicker() {
  document.getElementById('ops-picker').style.display = 'flex';
  document.getElementById('ops-tl-detail').style.display = 'none';
  document.getElementById('ops-country-detail').style.display = 'none';
}

function opsSelectTeamLeader(tl) {
  document.getElementById('ops-picker').style.display = 'none';
  document.getElementById('ops-country-detail').style.display = 'none';
  document.getElementById('ops-tl-detail').style.display = 'block';

  opsFiltered = Object.keys(opsDisData).filter(op => opsDisData[op].TEAMLEADER === tl);
  document.getElementById('ops-showing').textContent = opsFiltered.length;
  document.getElementById('ops-total').textContent   = opsFiltered.length;
  renderOpsTable(null);
}

/* Semáforo unificado con el resto de la app: rojo <25%, neutro 25-30%, verde 30%+ */
function approveClass(pct) {
  if (pct === null || pct === undefined || isNaN(pct)) return '';
  return repApproveClass(pct);
}

function renderOpsTable(filterCountry) {
  const table = document.getElementById('ops-table');
  const tbody = document.getElementById('ops-tbody');
  const thead = document.getElementById('ops-thead');
  const empty = document.getElementById('ops-empty');

  if (opsFiltered.length === 0) {
    table.style.display = 'none'; empty.style.display = 'flex'; return;
  }
  empty.style.display = 'none'; table.style.display = 'table';

  const idx = window._opsIdx || {};
  // Which countries to show: if filtered by país, only that one; else all
  const visibleCountries = filterCountry ? [filterCountry] : opsCountries;

  const M = 2; // Total, Approve %
  const mLabels = ['Total', 'Approve %'];

  // THEAD — compact sizing
  let h1 = `<tr><th rowspan="2" class="ops-identity-cell" style="position:sticky;left:0;z-index:3;background:var(--nav-bg);color:#fff;text-align:left;padding:10px 14px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;border-bottom:2px solid rgba(255,255,255,.1)">Operador</th>`;
  visibleCountries.forEach(co => {
    h1 += `<th colspan="${M}" class="country-group">${countryFlag(co)}${co}</th>`;
  });
  h1 += '</tr>';

  let h2 = '<tr class="sub-header">';
  visibleCountries.forEach(() => mLabels.forEach(m => { h2 += `<th>${m}</th>`; }));
  h2 += '</tr>';
  thead.innerHTML = h1 + h2;

  // TBODY
  tbody.innerHTML = opsFiltered.map(op => {
    const dis  = opsDisData[op] || {};
    const name = dis.ASESORES || '—';

    let row = `<tr><td class="ops-identity-cell" style="position:sticky;left:0;background:var(--card-bg);z-index:1;padding:8px 14px;border-bottom:1px solid var(--border)">
      <span class="ops-name-inline">${name}</span><span class="ops-code-inline">${op}</span>
    </td>`;

    visibleCountries.forEach((co, ci) => {
      const r  = (idx[op]||{})[co];
      const sc = ci === 0 ? '' : 'country-start';
      if (!r) {
        for (let i=0;i<M;i++) row += `<td class="metric-cell ${i===0?sc:''} ops-empty-cell">—</td>`;
      } else {
        const total = Number(r.Total) || 0;
        const rawPct = r['Approve (%)'];
        const approvePct = (rawPct !== undefined && rawPct !== null && rawPct !== '') ? Number(rawPct) : null;
        const ac = approveClass(approvePct);
        const bgStyle = ac === 'rep-approve-good' ? 'background:rgba(22,163,74,.06)'
                      : ac === 'rep-approve-mid'  ? 'background:rgba(16,24,20,.025)'
                      : ac === 'rep-approve-bad'  ? 'background:rgba(220,38,38,.06)' : '';
        const apText = approvePct !== null ? `${approvePct.toFixed(1)}%` : '—';
        row += `<td class="metric-cell ${sc}" style="${bgStyle}">${total || '—'}</td>`;
        row += `<td class="metric-cell ${ac}" style="font-weight:700">${apText}</td>`;
      }
    });
    return row + '</tr>';
  }).join('');
}

/* Vista plana por país: PEROP1AM con Total >= 1 en dt_ops Y asignado a un Team Leader en dt_dis.
   Reutilizable — la usa tanto la vista de Approve Stats como el widget "Top Operadores" del Inicio. */
let opsCountryRows     = []; // sin filtrar, para poblar filtros
let opsCountryFiltered = [];

function opsGetCountryRows(country) {
  const idx = window._opsIdx || {};
  const rows = [];
  Object.keys(idx).forEach(operator => {
    const r = (idx[operator] || {})[country];
    if (!r) return;
    const total = Number(r.Total) || 0;
    if (total < 1) return;
    const dis = opsDisData[operator];
    if (!dis || !dis.TEAMLEADER || dis.TEAMLEADER === '—') return; // debe pertenecer a un Team Leader

    const approvePctRaw = r['Approve (%)'];
    const rejectPctRaw  = r['Reject (%)'];
    const trashPctRaw   = r['Trash (%)'];
    const avgPriceRaw   = r['Avg Price ($)'];

    rows.push({
      teamLeader: dis.TEAMLEADER,
      asesor: dis.ASESORES || '—',
      operator,
      horario: dis.HORARIO || '—',
      total,
      approve: Number(r.Approve) || 0,
      approvePct: (approvePctRaw !== undefined && approvePctRaw !== null && approvePctRaw !== '') ? Number(approvePctRaw) : null,
      reject: Number(r.Reject) || 0,
      rejectPct: (rejectPctRaw !== undefined && rejectPctRaw !== null && rejectPctRaw !== '') ? Number(rejectPctRaw) : null,
      trash: Number(r.Trash) || 0,
      trashPct: (trashPctRaw !== undefined && trashPctRaw !== null && trashPctRaw !== '') ? Number(trashPctRaw) : null,
      avgPrice: (avgPriceRaw !== undefined && avgPriceRaw !== null && avgPriceRaw !== '') ? Number(avgPriceRaw) : null,
    });
  });

  // Orden: Total es el criterio más importante, Approve (%) desempata
  rows.sort((a, b) => (b.total - a.total) || (b.approvePct - a.approvePct));
  return rows;
}

function opsShowCountryDetail(country) {
  document.getElementById('ops-picker').style.display = 'none';
  document.getElementById('ops-tl-detail').style.display = 'none';
  document.getElementById('ops-country-detail').style.display = 'block';

  document.getElementById('ops-country-title').innerHTML = `${countryFlag(country)}${country}`;

  opsCountryRows = opsGetCountryRows(country);
  document.getElementById('ops-cf-tl').value = '';
  document.getElementById('ops-cf-hor').value = '';
  opsPopulateCountryFilters();
  applyOpsCountryFilters();
}

function opsPopulateCountryFilters() {
  const unique = (key) => [...new Set(opsCountryRows.map(r => r[key]).filter(v => v && v !== '—'))].sort();
  const fillSelect = (id, values) => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '<option value="">Todos</option>' + values.map(v => `<option value="${v}">${v}</option>`).join('');
    if (prev) sel.value = prev;
  };
  fillSelect('ops-cf-tl', unique('teamLeader'));
  fillSelect('ops-cf-hor', unique('horario'));
}

function applyOpsCountryFilters() {
  const tl  = document.getElementById('ops-cf-tl').value;
  const hor = document.getElementById('ops-cf-hor').value;

  opsCountryFiltered = opsCountryRows.filter(r => {
    if (tl && r.teamLeader !== tl) return false;
    if (hor && r.horario !== hor) return false;
    return true;
  });

  document.getElementById('ops-cf-pill-tl')?.classList.toggle('active', !!tl);
  document.getElementById('ops-cf-pill-hor')?.classList.toggle('active', !!hor);
  document.getElementById('ops-country-count').textContent = opsCountryFiltered.length;
  renderOpsCountryTable(opsCountryFiltered);
}

function renderOpsCountryTable(rows) {
  const table = document.getElementById('ops-country-table');
  const empty = document.getElementById('ops-country-empty');
  const tbody = document.getElementById('ops-country-tbody');

  if (rows.length === 0) {
    table.style.display = 'none';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  table.style.display = 'table';

  tbody.innerHTML = rows.map(r => {
    const ac = approveClass(r.approvePct);
    return `<tr>
      <td>${recTlBadge(r.teamLeader)}</td>
      <td>${r.asesor}</td>
      <td>${r.operator}</td>
      <td>${gdScheduleBadge(r.horario)}</td>
      <td>${r.total}</td>
      <td>${r.approve}</td>
      <td class="${ac}" style="font-weight:700">${r.approvePct !== null ? r.approvePct.toFixed(1)+'%' : '—'}</td>
      <td>${r.reject}</td>
      <td>${r.rejectPct !== null ? r.rejectPct.toFixed(1)+'%' : '—'}</td>
      <td>${r.trash}</td>
      <td>${r.trashPct !== null ? r.trashPct.toFixed(1)+'%' : '—'}</td>
      <td>${r.avgPrice !== null ? r.avgPrice.toFixed(2) : '—'}</td>
    </tr>`;
  }).join('');
}
