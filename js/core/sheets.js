/* Lectura de hojas de Google publicadas en la web (Archivo → Compartir → Publicar en la web).
   Compartido por Stats OPs Live (ventas) y la asistencia de GoodDay.
   · Se leen como CSV directo desde el navegador: Google responde con CORS abierto,
     pero SOLO si la página está publicada (https://…), no abierta con doble clic (file://).
   · Los operadores se emparejan por el NÚMERO final del PEROP1AM (las hojas mezclan prefijos:
     PEROP1AM-, COLOP1AM-, co-operator-…). */

/* CSV → matriz de celdas (respeta comillas, comas dentro de comillas y "" escapadas) */
function sheetParseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* "1,234" / "53%" / "" → número (0 si no hay número) */
function sheetNum(v) {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/* "PEROP1AM-40881" / "COLOP1AM-40881" / "co-operator-40881" → "40881" (o null) */
function sheetOperatorNumber(v) {
  const m = String(v ?? '').trim().match(/(\d{3,})$/);
  return m ? m[1] : null;
}

/* Índice de una columna por nombre de encabezado (sin distinguir mayúsculas; la primera que calce) */
function sheetColumn(header, name) {
  return header.findIndex(h => String(h).trim().toLowerCase() === name.toLowerCase());
}

/* Link publicado (pubhtml o pub) → URL del CSV */
function sheetCsvUrl(url) {
  let u = String(url || '').trim().replace('/pubhtml', '/pub');
  if (!/[?&]output=csv/.test(u)) u += (u.includes('?') ? '&' : '?') + 'output=csv';
  return u;
}

/* Link publicado → URL para abrir la hoja en el navegador (pubhtml) */
function sheetViewUrl(url) {
  return String(url || '').trim().replace(/\/pub(\?|$)/, '/pubhtml$1').replace(/[?&]output=csv/, '');
}

/* Link guardado en "Actualización de Data" (dt_data_links) o, si no hay, el de por defecto */
function sheetSavedUrl(key, defaultUrl) {
  const saved = (typeof dataLinksMap !== 'undefined') && dataLinksMap[key];
  return (saved && saved.url) || defaultUrl;
}

/* Trae de Supabase los links guardados de estas claves (si falla, se usan los de por defecto) */
async function sheetLoadLinks(keys) {
  try {
    const rows = await sbFetch('dt_data_links', `select=*&section_key=in.(${keys.join(',')})`);
    keys.forEach(k => { delete dataLinksMap[k]; });
    (rows || []).forEach(r => { dataLinksMap[r.section_key] = r; });
  } catch (err) {
    console.warn('No se pudieron leer los links guardados, se usan los de por defecto', err);
  }
}

/* Descarga el CSV de una hoja publicada, con mensajes de error entendibles. label = nombre para los avisos. */
async function sheetFetchCsv(url, label) {
  if (location.protocol === 'file:') {
    throw new Error(`No se puede leer la hoja de ${label} con la página abierta como archivo local (file://). Ábrela desde la dirección publicada (https://…).`);
  }
  let res;
  try {
    // El "_" evita la caché del navegador; Google igual publica cambios cada ~5 min
    res = await fetch(`${url}&_=${Date.now()}`, { cache: 'no-store' });
  } catch (e) {
    throw new Error(`No se pudo conectar con la hoja de ${label} (Google Sheets). Posibles causas: la red bloquea Google (docs.google.com / googleusercontent.com), una extensión del navegador, o no hay internet.`);
  }
  if (!res.ok) throw new Error(`La hoja de ${label} respondió con error ${res.status}. Revisa que siga publicada en la web.`);
  return sheetParseCsv(await res.text());
}
