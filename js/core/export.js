/* Copiar / descargar — UN solo sistema para toda la página (Reporte, Leads, Ventas por Fuera, Top TL,
   fichas de Equipos 360, mensajes de Recalls…).

   La imagen sale IDÉNTICA para todos, sin importar el zoom, el tamaño de la ventana, la pantalla
   (retina o no) ni si se abre desde el celular:
   · se captura una COPIA armada aparte, fuera de la vista, con ANCHO FIJO en px (su CSS de exportación);
   · la captura simula siempre una ventana de escritorio (GC_EXPORT_WINDOW): nunca aplica el diseño de celular;
   · escala fija ×2 (no la del monitor de cada uno);
   · banderas en alta resolución y sin srcset (el srcset elegía según la pantalla);
   · se espera a que estén cargadas la letra (Lexend) y las imágenes antes de capturar.
   html2canvas se descarga solo la primera vez que alguien exporta. */

const GC_H2C_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
const GC_EXPORT_SCALE = 2;
const GC_EXPORT_WINDOW = 2000;

/* Mensajes iguales en toda la página */
const GC_MSG = {
  working:    'Generando imagen…',
  imgCopied:  '✓ ¡Listo! La imagen ya está en tu portapapeles',
  textCopied: '✓ ¡Listo! El texto ya está en tu portapapeles',
  downloaded: '✓ Imagen descargada',
  noClipImg:  'Este navegador no permite copiar imágenes — usa "Descargar imagen".',
  failed:     'No se pudo generar la imagen.',
};

let gcH2cPromise = null;
function gcLoadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (!gcH2cPromise) {
    gcH2cPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GC_H2C_URL;
      s.onload = () => resolve(window.html2canvas);
      s.onerror = () => { gcH2cPromise = null; s.remove(); reject(new Error('No se pudo cargar la herramienta de captura. Revisa tu conexión e intenta de nuevo.')); };
      document.head.appendChild(s);
    });
  }
  return gcH2cPromise;
}
// Nombre de siempre (lo usaban Reporte, Top TL, Leads, Ventas por Fuera y Equipos 360)
function repLoadHtml2Canvas() { return gcLoadHtml2Canvas(); }

/* Banderas a 80x60 y sin srcset: misma nitidez para todos */
function gcSharpenFlags(root) {
  root.querySelectorAll('img[src*="flagcdn.com"]').forEach(img => {
    img.removeAttribute('srcset');
    img.src = img.src.replace(/\/\d+x\d+\//, '/80x60/');
  });
}

/* Captura un nodo armado aparte (fuera de pantalla) → canvas */
async function gcCaptureNode(node) {
  const h2c = await gcLoadHtml2Canvas();
  gcSharpenFlags(node);
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-30000px;top:0;';
  holder.appendChild(node);
  document.body.appendChild(holder);
  try {
    await Promise.all([...node.querySelectorAll('img')].map(img =>
      img.complete ? null : new Promise(resolve => { img.onload = img.onerror = resolve; })));
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch { /* sigue igual */ } }
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--card-bg').trim() || '#1c1e21';
    return await h2c(node, {
      backgroundColor: bg, scale: GC_EXPORT_SCALE, useCORS: true, logging: false,
      windowWidth: GC_EXPORT_WINDOW, windowHeight: 1200,
    });
  } finally {
    holder.remove();
  }
}

/* Texto al portapapeles (con plan B para navegadores sin permiso) → true / false */
async function gcCopyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (err) {
    console.error('Error copiando al portapapeles:', err);
    return false;
  }
}

/* Estado junto a los botones: tone = 'work' | 'ok' | 'error'. Los "ok" se borran solos. */
function gcSetStatus(statusId, text, tone = 'ok') {
  const status = document.getElementById(statusId);
  if (!status) return;
  clearTimeout(status._gcTimer);
  status.style.color = tone === 'ok' ? 'var(--green)' : tone === 'error' ? 'var(--red)' : 'var(--text-light)';
  status.textContent = text;
  if (tone === 'ok') status._gcTimer = setTimeout(() => { status.textContent = ''; }, 5000);
}

/* Exportar como imagen: build() arma el nodo (con su ancho fijo en CSS); action = 'copy' | 'download' */
async function gcExportImage({ action, build, filename, statusId, buttonIds = [] }) {
  const btns = buttonIds.map(id => document.getElementById(id)).filter(Boolean);
  btns.forEach(b => { b.disabled = true; });
  gcSetStatus(statusId, GC_MSG.working, 'work');
  try {
    const node = await build();
    const canvas = await gcCaptureNode(node);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error(GC_MSG.failed);
    if (action === 'copy') {
      if (!(navigator.clipboard && window.ClipboardItem && window.isSecureContext)) throw new Error(GC_MSG.noClipImg);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      gcSetStatus(statusId, GC_MSG.imgCopied);
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      gcSetStatus(statusId, GC_MSG.downloaded);
    }
  } catch (err) {
    console.error('Error exportando imagen:', err);
    gcSetStatus(statusId, (err && err.message) ? err.message : GC_MSG.failed, 'error');
  } finally {
    btns.forEach(b => { b.disabled = false; });
  }
}
// Nombre de siempre (Top TL, Leads, Ventas por Fuera)
function exportCardImage(opts) { return gcExportImage(opts); }

/* Encabezado y pie IGUALES en todas las imágenes de tarjeta (Top TL, Leads, Ventas por Fuera, Equipos 360) */
function gcStampText(date = new Date()) {
  const d = new Date(date);
  return `${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}
function gcExportHead(title, { sub = '', stamp = new Date() } = {}) {
  return `<div class="tl-export-head">
    <div class="tl-export-title">${title}${sub ? ` <span class="leads-export-mode">${sub}</span>` : ''}</div>
    <div class="tl-export-stamp">${escapeHtml(gcStampText(stamp))}</div>
  </div>`;
}
function gcExportFoot(text = '') {
  const u = typeof getCurrentUser === 'function' ? getCurrentUser() : null;
  return `<div class="tl-export-foot">${text ? `${text} · ` : ''}Gestión Center${u ? ` · generada por ${escapeHtml(u[0])}` : ''} · ${escapeHtml(gcStampText())}</div>`;
}

/* Nombre de archivo seguro: "ficha-ana-perez-2026-10-01.png" */
function gcFileName(...parts) {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const slug = parts.filter(Boolean).join('-').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.png`;
}
