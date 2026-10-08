/* Errores de calidad por OP — 3 hojas de Google publicadas en la web (se leen EN VIVO, como la asistencia).
   Las usan Equipos 360 (js/views/goodday.js) y la campanita (alertas de calidad).

   · Gestión       → TEAMLEADER | PEROP1AM | fecha (d/m/aaaa) | usuario | ID DE LA ORDEN | TIPO DE FALLO | DETALLE DEL FALLO | AÑADIR DETALLE
   · Tipificación  → TEAMLEADER | ID | SUBSTATUS | COMENTARIO TIPIFICADO POR EL ASESOR | PEROP1AM | FECHA DE LA AUDITORIA (dd-mm, sin año)
   · Verificación  → FECHA | INDEX | PEROP1AM | CON ERROR/SIN ERROR | OBSERVACION (texto libre: cada texto es su propio tipo)
   También: errores NUEVOS de hoy (errSyncSeen, supabase/16) y el descuento del Bono de Check y Approve (bono*).
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
function errCsvUrl(url) { return sheetCsvUrl(url); }

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

/* Igual que errNorm, pero sin palabras de relleno ni signos: "TIPO DEL FALLO" = "TIPO DE FALLO" = "Tipo fallo:".
   Así un cambio chico en el encabezado de la hoja no deja la hoja entera sin leer. */
function errLoose(s) {
  return errNorm(s).replace(/[^A-Z0-9Ñ ]/g, ' ').replace(/\b(DE|DEL|LA|EL|LOS|LAS|AL)\b/g, ' ').replace(/\s+/g, ' ').trim();
}

/* Columna por nombre: primero el nombre exacto; si no está, el parecido (errLoose) */
function errCol(header, ...names) {
  const wanted = names.map(errNorm);
  const exact = header.findIndex(h => wanted.includes(errNorm(h)));
  if (exact >= 0) return exact;
  const loose = names.map(errLoose);
  return header.findIndex(h => loose.includes(errLoose(h)));
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
  if (C.type < 0) {
    const expected = { gestion: 'TIPO DE FALLO', tipificacion: 'SUBSTATUS', verificacion: 'OBSERVACION' }[src.key];
    throw new Error(`La hoja "${src.full}" no tiene la columna «${expected}» (tipo de error). ¿Le cambiaron el nombre al encabezado?`);
  }

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
    errAssignKeys(records);   // en el orden de las hojas (así las filas repetidas numeran siempre igual)
    records.sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
    const cache = { records, status, fetchedAt: Date.now() };
    await errSyncSeen(cache);   // errores nuevos de hoy (memoria compartida, supabase/16)
    errCache = cache;
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

/* ══════════════════════════════
   ERRORES NUEVOS — memoria compartida en Supabase (supabase/16: dt_errores_vistos + err_vistos_sync)
   Las hojas solo traen la FECHA del error, no la hora en que se registró. Por eso cada error lleva una
   "huella" (hoja + OP + orden + fecha + tipo + detalle) y Supabase anota cuándo la vio por primera vez
   cualquier persona con la página abierta. "Nuevo" = apareció hoy. Si alguien corrige el texto de un
   error en la hoja, su huella cambia: sale como nuevo (y el anterior como quitado).
══════════════════════════════ */
const ERR_SEEN_REFRESH_MS = 15 * 60 * 1000;   // aunque las hojas no cambien, se vuelve a preguntar cada 15 min
let errSeenSig = '';          // huella del último envío (si las hojas no cambiaron, no se vuelve a mandar)
let errSeenOffUntil = 0;      // falta el script 16: no se insiste hasta esta hora

/* Hash corto y estable de un texto (cyrb53) */
function errHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function errDateKey(d) {
  return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
}

/* Huella de cada registro (r.key). Dos filas idénticas se distinguen con #2, #3… (en el orden de la hoja) */
function errAssignKeys(records) {
  const seen = new Map();
  records.forEach(r => {
    const base = `${r.source}:${errHash([r.num, r.orderId, errDateKey(r.date), r.type, r.detail].join('|'))}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    r.key = n > 1 ? `${base}#${n}` : base;
  });
}

/* Manda las huellas actuales y recibe lo aparecido / quitado hoy. Deja en cache.seen:
   { ok, newAt: Map(clave → Date), removed: [{ hoja, num, fecha, tipo, quitado }], at } — o { ok: false } */
async function errSyncSeen(cache) {
  const prev = errCache && errCache.seen;
  if (Date.now() < errSeenOffUntil) { cache.seen = { ok: false, missing: true }; return; }
  const okSources = ERR_SOURCES.filter(s => cache.status[s.key] && cache.status[s.key].ok).map(s => s.key);
  if (!okSources.length) { cache.seen = prev || { ok: false }; return; }
  const desde = errMonthStart(-1);
  const items = cache.records
    .filter(r => okSources.includes(r.source) && (!r.date || r.date >= desde))
    .map(r => ({ clave: r.key, hoja: r.source, num: r.num, fecha: errDateKey(r.date) || null, tipo: r.type }));
  const today = errDayStart(0);
  const sig = `${errDateKey(today)}|${okSources.join(',')}|${errHash(items.map(i => i.clave).sort().join(','))}`;
  if (prev && prev.ok && sig === errSeenSig && Date.now() - prev.at < ERR_SEEN_REFRESH_MS) { cache.seen = prev; return; }
  try {
    const rows = await sbRpc('err_vistos_sync', { p_items: items, p_hojas: okSources, p_desde: errDateKey(desde), p_hoy: today.toISOString() });
    const newAt = new Map();
    const removed = [];
    (rows || []).forEach(x => {
      if (x.quitado) {
        const [y, m, d] = String(x.fecha || '').split('-').map(Number);
        removed.push({ hoja: x.hoja, num: x.num, fecha: y ? new Date(y, m - 1, d) : null, tipo: x.tipo, quitado: new Date(x.quitado) });
      } else {
        newAt.set(x.clave, new Date(x.primera_vez));
      }
    });
    errSeenSig = sig;
    cache.seen = { ok: true, newAt, removed, at: Date.now() };
  } catch (err) {
    // Sin el script 16 (la función no existe): no se insiste por 10 min
    const missing = /err_vistos_sync|schema cache|404/i.test(err.message || '');
    if (missing) errSeenOffUntil = Date.now() + 10 * 60 * 1000;
    console.warn('Errores nuevos no disponibles:', err.message);
    cache.seen = prev && prev.ok ? prev : { ok: false, missing };
  }
}

/* Cuándo se detectó por primera vez (Date) si apareció HOY, o null */
function errNewAt(r) {
  const s = errCache && errCache.seen;
  return (s && s.ok && r.key && s.newAt.get(r.key)) || null;
}
function errSeenReady() { return !!(errCache && errCache.seen && errCache.seen.ok); }
function errFmtTime(d) { return d ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : ''; }

/* ══════════════════════════════
   DESCUENTO DEL BONO DE CHECK Y APPROVE — por errores de VERIFICACIÓN del mes actual
   Tramos editables (dt_ajustes, clave bono_verificacion — se cambian en Actualización de Data);
   si no se pueden leer se usan los de por defecto. Cada tramo = "desde N errores → X% de descuento".
══════════════════════════════ */
const BONO_DEFAULT_TIERS = [{ desde: 3, pct: 10 }, { desde: 6, pct: 25 }, { desde: 11, pct: 50 }, { desde: 26, pct: 100 }];
const BONO_NAME = 'Bono de Check y Approve';
let bonoTiers = BONO_DEFAULT_TIERS;
let bonoTiersMeta = null;     // { updated_at, updated_by } de la fila guardada (null = tramos por defecto)
let bonoTiersAt = 0;

function bonoNormalizeTiers(list) {
  return (Array.isArray(list) ? list : [])
    .map(t => ({ desde: Math.round(Number(t.desde)), pct: Math.round(Number(t.pct)) }))
    .filter(t => t.desde >= 1 && t.pct > 0 && t.pct <= 100)
    .sort((a, b) => a.desde - b.desde);
}

async function bonoFetchTiers(force = false) {
  if (!force && Date.now() - bonoTiersAt < 5 * 60 * 1000) return bonoTiers;
  try {
    const rows = await sbFetch('dt_ajustes', 'select=valor,updated_at,updated_by&clave=eq.bono_verificacion');
    const tiers = rows && rows[0] ? bonoNormalizeTiers(rows[0].valor && rows[0].valor.tramos) : [];
    bonoTiers = tiers.length ? tiers : BONO_DEFAULT_TIERS;
    bonoTiersMeta = rows && rows[0] ? { updated_at: rows[0].updated_at, updated_by: rows[0].updated_by } : null;
  } catch (err) {
    console.warn('Tramos del bono: se usan los de por defecto (¿falta el script 16?)', err.message);
  }
  bonoTiersAt = Date.now();
  return bonoTiers;
}

/* "3 a 5", "26 o más" */
function bonoTierRange(i, tiers = bonoTiers) {
  const t = tiers[i], next = tiers[i + 1];
  if (!next) return `${t.desde} o más`;
  return next.desde - 1 === t.desde ? `${t.desde}` : `${t.desde} a ${next.desde - 1}`;
}

/* Errores de Verificación con fecha en el mes actual (los que cuentan para el bono) */
function bonoMonthRecords(records) {
  const start = errMonthStart(0), end = errMonthStart(1);
  return records.filter(r => r.source === 'verificacion' && r.date && r.date >= start && r.date < end);
}

/* count → { count, pct, idx (tramo actual o -1), next (tramo siguiente o null), faltan } */
function bonoInfo(count) {
  let idx = -1;
  bonoTiers.forEach((t, i) => { if (count >= t.desde) idx = i; });
  const next = bonoTiers[idx + 1] || null;
  return { count, pct: idx >= 0 ? bonoTiers[idx].pct : 0, idx, next, faltan: next ? next.desde - count : null };
}

function bonoLevel(pct) { return pct >= 100 ? 4 : pct >= 50 ? 3 : pct >= 25 ? 2 : pct > 0 ? 1 : 0; }

function bonoBadge(info, { withZero = false } = {}) {
  if (!info.pct) return withZero ? '<span class="bono-badge bono-0" title="Sin descuento">0%</span>' : '';
  return `<span class="bono-badge bono-${bonoLevel(info.pct)}" title="Descuento del ${BONO_NAME}: ${info.count} errores de Verificación este mes">−${info.pct}%</span>`;
}

/* "le falta 1 error para −25%" (o null si no aplica) */
function bonoNextText(info) {
  if (!info.next) return info.pct ? 'ya está en el tramo más alto' : null;
  return `${info.faltan === 1 ? 'le falta 1 error' : `le faltan ${info.faltan} errores`} para −${info.next.pct}%`;
}
