/* Modales propios — reemplazan alert / confirm / prompt nativos.
   · Mismo estilo que la página, y funcionan en celular.
   · Devuelven Promesas: usar con await (no congelan la página como los nativos).
   · El texto SIEMPRE entra como texto (textContent), nunca como HTML: seguro por diseño.
   · Si se piden varios a la vez, se muestran uno detrás de otro (cola).

   uiAlert(msg, { title, tone })                        → Promise<void>
   uiConfirm(msg, { title, confirmText, danger })       → Promise<boolean>
   uiPrompt(msg, { title, defaultValue, inputType,
                   placeholder, allowEmpty, validate }) → Promise<string | null>  (null = canceló) */

const UI_TONE_ICON = { info: 'i', warning: '!', danger: '!', success: '✓' };

let uiModalQueue = Promise.resolve();
let uiModalSeq = 0;

function uiEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

function uiButton(text, className, onClick) {
  const b = uiEl('button', `btn ${className}`, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/* Abre un modal. build(box, close) arma el contenido y devuelve { onEnter, onCancel, focusEl }. */
function uiModalOpen(build) {
  const run = () => new Promise(resolve => {
    const prevFocus = document.activeElement;
    const overlay = uiEl('div', 'ui-modal-overlay');
    const box = uiEl('div', 'ui-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    overlay.appendChild(box);

    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.remove('open');
      setTimeout(() => overlay.remove(), 160);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      resolve(value);
    };

    const { onEnter, onCancel, focusEl } = build(box, close);

    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        onCancel();
      } else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') {
        e.preventDefault();
        onEnter();
      } else if (e.key === 'Tab') {
        // El foco no se escapa del modal mientras está abierto
        const items = [...box.querySelectorAll('button, input, select')].filter(el => !el.disabled);
        if (items.length === 0) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) onCancel(); });

    document.body.appendChild(overlay);
    // Si se cerró antes de este frame (cierre muy rápido), no volver a marcarlo como abierto
    requestAnimationFrame(() => { if (!done) overlay.classList.add('open'); });
    if (focusEl) focusEl.focus();
  });

  const p = uiModalQueue.then(run);
  uiModalQueue = p.catch(() => {});
  return p;
}

/* Encabezado (ícono + título) y mensaje comunes a los 3 tipos */
function uiModalHeader(box, { title, message, tone }) {
  const t = tone || 'info';
  box.classList.add(`ui-modal--${t}`);
  const head = uiEl('div', 'ui-modal-head');
  head.appendChild(uiEl('span', 'ui-modal-icon', UI_TONE_ICON[t] || UI_TONE_ICON.info));
  const h = uiEl('h2', 'ui-modal-title', title);
  h.id = `ui-modal-title-${++uiModalSeq}`;
  box.setAttribute('aria-labelledby', h.id);
  head.appendChild(h);
  box.appendChild(head);
  if (message) box.appendChild(uiEl('p', 'ui-modal-msg', message));
}

function uiAlert(message, { title = 'Aviso', tone = 'info' } = {}) {
  return uiModalOpen((box, close) => {
    uiModalHeader(box, { title, message, tone });
    const actions = uiEl('div', 'ui-modal-actions');
    const ok = uiButton('Entendido', 'btn-primary', () => close());
    actions.appendChild(ok);
    box.appendChild(actions);
    return { onEnter: () => close(), onCancel: () => close(), focusEl: ok };
  });
}

function uiConfirm(message, { title = '¿Estás seguro?', confirmText = 'Aceptar', cancelText = 'Cancelar', danger = false } = {}) {
  return uiModalOpen((box, close) => {
    uiModalHeader(box, { title, message, tone: danger ? 'danger' : 'warning' });
    const actions = uiEl('div', 'ui-modal-actions');
    const cancel = uiButton(cancelText, 'btn-ghost', () => close(false));
    const ok = uiButton(confirmText, danger ? 'btn-danger' : 'btn-primary', () => close(true));
    actions.append(cancel, ok);
    box.appendChild(actions);
    // En acciones peligrosas el foco arranca en "Cancelar": un Enter distraído no borra nada
    return { onEnter: () => {}, onCancel: () => close(false), focusEl: danger ? cancel : ok };
  });
}

/* Diálogo con contenido propio (un nodo DOM armado con uiEl — nunca HTML de datos).
   onConfirm: async () => null (ok, cierra) | 'mensaje' (error: se muestra y el diálogo sigue abierto).
   extraButton: { text, onClick } — botón adicional a la izquierda (no cierra el diálogo).
   cancelText: null = sin botón Cancelar. dismissible: false = no se cierra con Esc ni clic afuera
   (para pasos obligatorios, ej. cambiar la clave temporal).
   Devuelve Promise<boolean>: true si se confirmó y guardó, false si se canceló. */
function uiDialog({ title, message = '', body, tone = 'info', wide = false, confirmText = 'Guardar', cancelText = 'Cancelar', extraButton = null, onConfirm = null, dismissible = true, focusEl = null } = {}) {
  return uiModalOpen((box, close) => {
    if (wide) box.classList.add('ui-modal--wide');
    uiModalHeader(box, { title, message, tone });
    if (body) { const wrap = uiEl('div', 'ui-modal-body'); wrap.appendChild(body); box.appendChild(wrap); }
    const error = uiEl('div', 'ui-modal-error');
    error.setAttribute('role', 'alert');
    box.appendChild(error);

    const actions = uiEl('div', 'ui-modal-actions');
    if (extraButton) {
      const extra = uiButton(extraButton.text, 'btn-ghost ui-modal-extra', extraButton.onClick);
      actions.appendChild(extra);
    }
    const cancel = cancelText === null ? null : uiButton(cancelText, 'btn-ghost', () => close(false));
    const ok = uiButton(confirmText, 'btn-primary', async () => {
      if (!onConfirm) { close(true); return; }
      ok.disabled = true; error.textContent = '';
      const problem = await onConfirm();
      ok.disabled = false;
      if (problem) { error.textContent = problem; return; }
      close(true);
    });
    if (cancel) actions.append(cancel);
    actions.append(ok);
    box.appendChild(actions);
    // Enter no confirma aquí: con selects/casillas es fácil guardar sin querer
    return { onEnter: () => {}, onCancel: dismissible ? () => close(false) : () => {}, focusEl: focusEl || cancel || ok };
  });
}

function uiPrompt(message, {
  title = 'Ingresa un valor', defaultValue = '', placeholder = '', inputType = 'text',
  confirmText = 'Guardar', cancelText = 'Cancelar', allowEmpty = false, validate = null,
} = {}) {
  return uiModalOpen((box, close) => {
    uiModalHeader(box, { title, message, tone: 'info' });

    const field = uiEl('div', 'ui-modal-field');
    const input = uiEl('input', 'ui-modal-input');
    input.type = inputType;
    input.value = defaultValue;
    input.placeholder = placeholder;
    input.autocomplete = inputType === 'password' ? 'new-password' : 'off';
    input.setAttribute('aria-labelledby', box.getAttribute('aria-labelledby'));
    field.appendChild(input);

    if (inputType === 'password') {
      const eye = uiButton('Mostrar', 'btn-ghost btn-sm ui-modal-eye', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        eye.textContent = show ? 'Ocultar' : 'Mostrar';
        input.focus();
      });
      eye.setAttribute('aria-label', 'Mostrar u ocultar contraseña');
      field.appendChild(eye);
    }
    box.appendChild(field);

    const error = uiEl('div', 'ui-modal-error');
    error.setAttribute('role', 'alert');
    box.appendChild(error);

    const submit = () => {
      const value = input.value;
      if (!allowEmpty && !value.trim()) { error.textContent = 'Este campo no puede quedar vacío.'; input.focus(); return; }
      const problem = validate ? validate(value) : null;
      if (problem) { error.textContent = problem; input.focus(); return; }
      close(value);
    };
    input.addEventListener('input', () => { error.textContent = ''; });

    const actions = uiEl('div', 'ui-modal-actions');
    actions.append(
      uiButton(cancelText, 'btn-ghost', () => close(null)),
      uiButton(confirmText, 'btn-primary', submit),
    );
    box.appendChild(actions);

    setTimeout(() => input.select(), 0);
    return { onEnter: submit, onCancel: () => close(null), focusEl: input };
  });
}
