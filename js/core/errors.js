/* Errores de calidad por OP — 3 hojas de Google publicadas en la web (se leen EN VIVO, como la asistencia).
   Las usan Equipos 360 (js/views/goodday.js) y la campanita (alertas de calidad).

   · Gestión       → TEAMLEADER | PEROP1AM | fecha (d/m/aaaa) | usuario | ID DE LA ORDEN | TIPO DE FALLO | DETALLE DEL FALLO | AÑADIR DETALLE
   · Tipificación  → TEAMLEADER | ID | SUBSTATUS | COMENTARIO TIPIFICADO POR EL ASESOR | PEROP1AM | FECHA DE LA AUDITORIA (dd-mm, sin año)
   · Verificación  → FECHA | INDEX | PEROP1AM | CON ERROR/SIN ERROR | OBSERVACION (texto libre: cada texto es su propio tipo)
   Cada fila = 1 error. Se empareja al OP por el NÚMERO final del PEROP1AM (sheetOperatorNumber), así
   "COLOP1AM-41992" o "co-operator-24140" también encuentran a su OP.
   Los links se editan en "Actualización de Data" (dt_data_links: err_gestion / err_tipificacion / err_verificacion);
   si no hay uno guardado se usa el de por defecto. Se acepta el link "pubhtml" tal cual: se convierte a CSV solo. */

const ERR_BASE_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vT4hOS8Xld_Vl1aTr4tZJYFzhhdIhZC-wRJmz4hD-kRb0fo7puAM9P4sN3QgQm6-gKj9VzbYJeQrtje/pubhtml';

const ERR_SOURCES = [
  { key: 'gestion',      label: 'Gestión',      full: 'Errores de Gestión',      color: '#f87171', rgb: '248,113,113',
    linkKey: 'err_gestion',      defaultUrl: `${ERR_BASE_URL}?gid=0&single=true` },
  { key: 'tipificacion', label: 'Tipificación', full: 'Errores de Tipificación', color: '#fbbf24', rgb: '251,191,36',
    linkKey: 'err_tipificacion', defaultUrl: `${ERR_BASE_URL}?gid=1473650592&single=true` },
  { key: 'verificacion', label: 'Verificación', full: 'Errores de Verificación', color: '#60a5fa', rgb: '96,165,250',
    linkKey: 'err_verificacion', defaultUrl: `${ERR_BASE_URL}?gid=98689101&single=true` },
];

// Alertas automáticas (ventana de 7 días)
const ERR_ALERT_REPEAT_MIN = 3;   // mismo error (misma hoja + mismo tipo) 3+ veces en 7 días
const ERR_ALERT_SPIKE_MIN  = 3;   // 3+ errores esta semana y al menos el doble que la semana anterior

const ERR_CACHE_MS = 2 * 60 * 1000;
let errCache = null;    // { records, status: { key: { ok, count, error } }, fetchedAt }
let errPending = null;

function errSource(key) { return ERR_SOURCES.find(s => s.key === key); }

/* Link publicado (pubhtml o pub) → URL del CSV */
function errCsvUrl(url) {
  let u = String(url || '').trim().replace('/pubhtml', '/pub');
  if (!/[?&]output=csv/.test(u)) u += (u.includes('?') ? '&' : '?') + 'output=csv';
  return u;
}

function errSourceUrl(src) {
  const saved = (typeof dataLinksMap !== 'undefined') && dataLinksMap[src.linkKey];
  return (saved && saved.url) || src.defaultUrl;
}

/* Texto de encabezado/tipo comparable: mayúsculas, sin tildes, espacios simples, solo la primera línea */
function errNorm(s) {
  return String(s ?? '').split('\n')[0].normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
}

/* Tipo para mostrar/agrupar: mismo texto sin importar mayúsculas ni espacios extra */
function errTypeLabel(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}

/* "28/9/2026", "28/09/2026", "27-09" (sin año → año actual; si quedara en el futuro, el anterior) */
function errParseDate(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?$/);
  if (!m) return null;
  const day = Number(m[1]), month = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const now = new Date();
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  if (year < 100) year += 2000;
  let d = new Date(year, month - 1, day);
  if (!m[3] && d.getTime() > now.getTime() + 24 * 3600 * 1000) d = new Date(year - 1, month - 1, day);
  return d;
}

/* Fila de encabezado: la primera (de las 10 primeras) que tenga una celda "PEROP1AM" */
function errFindHeader(table) {
  for (let i = 0; i < Math.min(10, table.length); i++) {
    if ((table[i] || []).some(c => errNorm(c) === 'PEROP1AM')) return i;
  }
  return -1;
}

function errCol(header, ...names) {
  const wanted = names.map(errNorm);
  return header.findIndex(h => wanted.includes(errNorm(h)));
}

/* Columna de fecha cuando el encabezado viene roto (ej. "#VALUE!"): la que más valores con forma de fecha tenga */
function errDetectDateCol(header, rows) {
  let best = -1, bestHits = 0;
  header.forEach((_, i) => {
    const sample = rows.slice(0, 60);
    const hits = sample.filter(r => errParseDate(r[i])).length;
    if (hits > bestHits) { best = i; bestHits = hits; }
  });
  return bestHits >= 3 ? best : -1;
}

function errParseTable(src, table) {
  const h = errFindHeader(table);
  if (h < 0) throw new Error(`La hoja "${src.full}" no tiene la columna PEROP1AM. ¿Cambió el formato?`);
  const header = table[h];
  const rows = table.slice(h + 1).filter(r => r.some(c => String(c).trim() !== ''));
  const C = { op: errCol(header, 'PEROP1AM'), tl: errCol(header, 'TEAMLEADER', 'TEAM LEADER') };

  if (src.key === 'gestion') {
    Object.assign(C, {
      date: errCol(header, 'FECHA', 'FECHA DEL FALLO'), order: errCol(header, 'ID DE LA ORDEN', 'ID'),
      type: errCol(header, 'TIPO DE FALLO'), detail: errCol(header, 'DETALLE DEL FALLO'), extra: errCol(header, 'AÑADIR DETALLE'),
    });
    if (C.date < 0) C.date = errDetectDateCol(header, rows);
  } else if (src.key === 'tipificacion') {
    Object.assign(C, {
      date: errCol(header, 'FECHA DE LA AUDITORIA', 'FECHA'), order: errCol(header, 'ID', 'ID DE LA ORDEN'),
      type: errCol(header, 'SUBSTATUS'), detail: errCol(header, 'COMENTARIO TIPIFICADO POR EL ASESOR', 'COMENTARIO'), extra: -1,
    });
  } else {
    Object.assign(C, {
      date: errCol(header, 'FECHA'), order: errCol(header, 'INDEX', 'ID'),
      type: errCol(header, 'OBSERVACION'), detail: -1, extra: -1, flag: errCol(header, 'CON ERROR/SIN ERROR'),
    });
  }
  if (C.type < 0) throw new Error(`La hoja "${src.full}" no tiene la columna del tipo de error. ¿Cambió el formato?`);

  const get = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
  const records = [];
  let unassigned = 0;
  rows.forEach(r => {
    if (C.flag >= 0 && /SIN ERROR/i.test(get(r, C.flag))) return;   // por si algún día registran filas sin error
    const perop = get(r, C.op);
    const num = sheetOperatorNumber(perop);
    if (!num) { unassigned++; return; }
    records.push({
      source: src.key,
      num, perop,
      tl: get(r, C.tl),
      date: errParseDate(get(r, C.date)),
      type: errTypeLabel(get(r, C.type)) || 'SIN TIPO',
      detail: get(r, C.detail),
      extra: get(r, C.extra),
      orderId: get(r, C.order),
    });
  });
  return { records, unassigned };
}

async function errFetchLinks() {
  try {
    const keys = ERR_SOURCES.map(s => s.linkKey).join(',');
    const rows = await sbFetch('dt_data_links', `select=*&section_key=in.(${keys})`);
    ERR_SOURCES.forEach(s => { delete dataLinksMap[s.linkKey]; });
    (rows || []).forEach(r => { dataLinksMap[r.section_key] = r; });
  } catch (err) {
    console.warn('Errores: no se pudieron leer los links guardados, se usan los de por defecto', err);
  }
}

/* Las 3 hojas en paralelo; si una falla, las otras igual se usan (status dice cuál falló).
   force = ignorar la memoria de 2 min (botón Actualizar / auto-refresh). */
async function errFetch(force = false) {
  if (!force && errCache && Date.now() - errCache.fetchedAt < ERR_CACHE_MS) return errCache;
  if (errPending) return errPending;
  errPending = (async () => {
    await errFetchLinks();
    const results = await Promise.allSettled(ERR_SOURCES.map(async src => {
      const table = await sheetFetchCsv(errCsvUrl(errSourceUrl(src)), src.full.toLowerCase());
      return errParseTable(src, table);
    }));
    const records = [];
    const status = {};
    results.forEach((r, i) => {
      const src = ERR_SOURCES[i];
      if (r.status === 'fulfilled') {
        records.push(...r.value.records);
        status[src.key] = { ok: true, count: r.value.records.length, unassigned: r.value.unassigned };
      } else {
        console.error(`Errores: no se pudo leer "${src.full}"`, r.reason);
        status[src.key] = { ok: false, count: 0, error: (r.reason && r.reason.message) || 'No se pudo leer la hoja' };
      }
    });
    records.sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
    errCache = { records, status, fetchedAt: Date.now() };
    return errCache;
  })();
  try { return await errPending; } finally { errPending = null; }
}

/* Tras cambiar un link en Actualización de Data: la próxima lectura va a la hoja nueva */
function errOnLinkChanged(sectionKey) {
  if (ERR_SOURCES.some(s => s.linkKey === sectionKey)) errCache = null;
}

/* ── Periodos (como Ventas por Fuera: por mes calendario, más "Todo") ── */
const ERR_PERIODS = {
  cur:  { short: 'Mes actual',   offset: 0 },
  prev: { short: 'Mes anterior', offset: -1 },
  all:  { short: 'Todo',         offset: null },
};
const ERR_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function errDayStart(offsetDays = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

/* 1.º del mes (offset 0 = este mes, -1 = el anterior…) a las 00:00 */
function errMonthStart(offset = 0) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + offset, 1);
}

/* "octubre 2026" del periodo (o "todo el historial") */
function errPeriodLabel(period) {
  const p = ERR_PERIODS[period] || ERR_PERIODS.cur;
  if (p.offset === null) return 'todo el historial';
  const d = errMonthStart(p.offset);
  return `${ERR_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/* { start, end, prevStart, prevEnd } — end/prevEnd null = sin límite.
   · Mes actual: del 1.º a hoy; se compara con el MISMO tramo del mes anterior (1.º al mismo día),
     para que el día 5 no se compare contra un mes completo.
   · Mes anterior: el mes completo, comparado con el mes completo de antes. */
function errPeriodBounds(period) {
  const p = ERR_PERIODS[period] || ERR_PERIODS.cur;
  if (p.offset === null) return { start: null, end: null, prevStart: null, prevEnd: null };
  const start = errMonthStart(p.offset);
  const prevStart = errMonthStart(p.offset - 1);
  if (p.offset === 0) {
    const elapsed = new Date().getDate();   // días transcurridos del mes, contando hoy
    const prevEnd = new Date(prevStart);
    prevEnd.setDate(prevEnd.getDate() + elapsed);
    return { start, end: null, prevStart, prevEnd: prevEnd < start ? prevEnd : start };
  }
  return { start, end: errMonthStart(p.offset + 1), prevStart, prevEnd: start };
}

/* Texto de la comparación con el periodo anterior */
function errPrevLabel(period) {
  if (period === 'cur') return 'vs mismos días del mes anterior';
  if (period === 'prev') return 'vs el mes de antes';
  return '';
}

function errInRange(rec, from, to) {
  if (!from) return true;
  if (!rec.date) return false;
  return rec.date >= from && (!to || rec.date < to);
}

function errCountBySource(records) {
  const out = {};
  ERR_SOURCES.forEach(s => { out[s.key] = 0; });
  records.forEach(r => { out[r.source] = (out[r.source] || 0) + 1; });
  return out;
}

/* Tipos más frecuentes: [{ source, type, count, last }] */
function errTopTypes(records, limit = 8) {
  const map = new Map();
  records.forEach(r => {
    const k = `${r.source}::${r.type}`;
    const cur = map.get(k) || { source: r.source, type: r.type, count: 0, last: null };
    cur.count++;
    if (r.date && (!cur.last || r.date > cur.last)) cur.last = r.date;
    map.set(k, cur);
  });
  return [...map.values()].sort((a, b) => b.count - a.count || (b.last || 0) - (a.last || 0)).slice(0, limit);
}

/* ── Alertas automáticas de UN OP (sus registros) — siempre sobre los últimos 7 días ── */
function errComputeAlerts(records) {
  const weekStart = errDayStart(-6), prevStart = errDayStart(-13);
  const week = records.filter(r => errInRange(r, weekStart));
  const prevWeek = records.filter(r => errInRange(r, prevStart, weekStart));
  const alerts = [];

  errTopTypes(week, 50).filter(t => t.count >= ERR_ALERT_REPEAT_MIN).forEach(t => {
    alerts.push({
      kind: 'repeat', level: t.count >= ERR_ALERT_REPEAT_MIN + 2 ? 'critical' : 'warning',
      title: 'Error repetido',
      text: `Repitió ${t.count} veces «${t.type}» (${errSource(t.source).label}) en los últimos 7 días.`,
    });
  });
  if (week.length >= ERR_ALERT_SPIKE_MIN && week.length >= 2 * prevWeek.length) {
    alerts.push({
      kind: 'spike', level: 'warning',
      title: 'Aumento de errores',
      text: prevWeek.length
        ? `${week.length} errores esta semana vs ${prevWeek.length} la semana anterior (${(week.length / prevWeek.length).toFixed(1)}×).`
        : `${week.length} errores esta semana y ninguno la semana anterior.`,
    });
  }
  return alerts;
}

/* Agrupa registros por número de operador (Map num → registros, más recientes primero) */
function errGroupByNum(records) {
  const map = new Map();
  records.forEach(r => {
    if (!map.has(r.num)) map.set(r.num, []);
    map.get(r.num).push(r);
  });
  return map;
}

function errFmtDate(d, withYear = false) {
  if (!d) return 'sin fecha';
  return d.toLocaleDateString('es-ES', withYear ? { day: '2-digit', month: '2-digit', year: 'numeric' } : { day: '2-digit', month: '2-digit' });
}

function errSourceBadge(key) {
  const s = errSource(key);
  return `<span class="err-src-badge" style="--src:${s.color};--src-rgb:${s.rgb}">${escapeHtml(s.label)}</span>`;
}
