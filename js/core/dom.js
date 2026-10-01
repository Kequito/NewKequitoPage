/* Helpers para meter data dinámica en HTML de forma segura.
   REGLA: todo lo que venga de Supabase, Excel, texto pegado o inputs y vaya a innerHTML
   pasa por aquí. Números calculados y constantes del propio código no hace falta. */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/* Texto → HTML seguro. Sirve para contenido y para atributos entre comillas
   (value="…", title="…", style="…"). null/undefined → '' */
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

/* Texto → argumento JS (string) seguro dentro de un handler inline.
   Uso: onclick="fn(${jsArg(nombre)})"  — SIN comillas alrededor, jsArg ya las pone. */
function jsArg(value) {
  return escapeHtml(JSON.stringify(String(value ?? '')));
}

/* URL para href / window.open: solo http(s). Cualquier otra cosa (javascript:, data:…) → '#' */
function safeUrl(url) {
  const s = String(url ?? '').trim();
  return /^https?:\/\//i.test(s) ? s : '#';
}
