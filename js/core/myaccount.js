/* Mi cuenta — código de la cuenta, estado de la contraseña y cambio de la contraseña PROPIA.
   Se abre con clic en el usuario del topbar (o en el del sidebar).
   Todo lo valida Supabase (supabase/08_claves_y_codigos.sql): app_my_account y app_change_my_password
   (revisa la contraseña actual; los intentos fallidos cuentan para el bloqueo de 5 intentos).
   Si la cuenta entró con una CLAVE TEMPORAL (la generó un Supervisor en Gestión de Cuentas), al entrar
   se pide crear una propia y el diálogo no se cierra hasta hacerlo (o cerrar sesión). */

const MY_PASS_MIN = 6;   // mismo mínimo que app_change_my_password

let myAccount = null;        // { nombre, codigo, perop1am, cargo, tiene_clave, debe_cambiar, clave_cambiada_at } — null si falta el script 08
let myLoginPassword = null;  // la clave escrita en el login: SOLO en memoria, y solo hasta cambiar la temporal

async function myAccountLoad() {
  try {
    const rows = await sbRpc('app_my_account');
    myAccount = (rows && rows[0]) || null;
  } catch (err) {
    console.warn('Mi cuenta: Supabase todavía no tiene el script 08', err);
    myAccount = null;
  }
  myAccountRenderChip();
  return myAccount;
}

/* Cargo + código debajo del nombre, en el topbar */
function myAccountRenderChip() {
  const u = getCurrentUser();
  const el = document.getElementById('topbar-usercargo');
  if (!u || !el) return;
  el.textContent = `${u[2] || ''}${myAccount && myAccount.codigo ? ` · ${myAccount.codigo}` : ''}`;
}

function myFmtDateTime(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}

/* Campo de contraseña con botón Mostrar/Ocultar (armado con uiEl: nada de HTML con datos) */
function myPassField(label, autocomplete) {
  const wrap = uiEl('div', 'myacct-field');
  wrap.appendChild(uiEl('span', 'field-label', label));
  const row = uiEl('div', 'ui-modal-field');
  const input = uiEl('input', 'ui-modal-input');
  input.type = 'password';
  input.autocomplete = autocomplete;
  input.setAttribute('aria-label', label);
  const eye = uiButton('Mostrar', 'btn-ghost btn-sm ui-modal-eye', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.textContent = show ? 'Ocultar' : 'Mostrar';
    input.focus();
  });
  eye.setAttribute('aria-label', `Mostrar u ocultar: ${label}`);
  row.append(input, eye);
  wrap.appendChild(row);
  return { wrap, input };
}

/* ── Ficha "Mi cuenta" ── */
async function myAccountOpen() {
  await myAccountLoad();
  const u = getCurrentUser();
  if (!u) return;
  const a = myAccount;

  const body = uiEl('div', 'myacct');
  const code = uiEl('div', 'myacct-code');
  code.append(uiEl('span', 'myacct-code-lbl', 'Código de cuenta'), uiEl('span', 'myacct-code-val', a ? a.codigo : '—'));
  body.appendChild(code);

  const rows = [
    ['Nombre', u[0]],
    ['Cargo', u[2] || '—'],
    ['PEROP1AM', u[1] || '—'],
    ['Contraseña', !a ? '—'
      : !a.tiene_clave ? 'Sin contraseña (entras eligiendo tu nombre)'
      : a.debe_cambiar ? 'Clave temporal — debes cambiarla'
      : `Propia${a.clave_cambiada_at ? ` · cambiada el ${myFmtDateTime(a.clave_cambiada_at)}` : ''}`],
  ];
  // Solo la cuenta Admin ve esta línea (para el resto la cuenta es un Supervisor como cualquier otro)
  if (can('view.seguimiento')) rows.push(['Acceso', 'Admin 🧪 — Laboratorio y Seguimiento (solo tú lo ves)']);
  const dl = uiEl('div', 'myacct-rows');
  rows.forEach(([k, v]) => {
    const r = uiEl('div', 'myacct-row');
    r.append(uiEl('span', 'myacct-k', k), uiEl('span', 'myacct-v', v));
    dl.appendChild(r);
  });
  body.appendChild(dl);
  if (!a) body.appendChild(uiEl('div', 'perm-acct-warn', 'Falta correr en Supabase el script 08 (claves y códigos): por ahora no se puede cambiar la contraseña desde aquí.'));

  const change = await uiDialog({
    title: 'Mi cuenta',
    body,
    confirmText: !a ? 'Entendido' : a.tiene_clave ? 'Cambiar contraseña' : 'Crear contraseña',
    cancelText: a ? 'Cerrar' : null,
  });
  if (change && a) await myAccountChangePassword();
}

/* ── Cambiar (o crear) mi contraseña. forced = clave temporal recién usada: no se puede saltar ── */
async function myAccountChangePassword({ forced = false } = {}) {
  if (!myAccount) await myAccountLoad();
  if (!myAccount) {
    await uiAlert('Falta correr en Supabase el script 08 (claves y códigos).', { title: 'No disponible', tone: 'warning' });
    return false;
  }
  const hasPass = myAccount.tiene_clave;
  // Justo después de entrar con la temporal ya la sabemos: no se vuelve a pedir
  const knownCurrent = forced && myLoginPassword ? myLoginPassword : null;

  const body = uiEl('div', 'myacct-form');
  let actual = null;
  if (hasPass && !knownCurrent) {
    actual = myPassField(myAccount.debe_cambiar ? 'Clave temporal que te dieron' : 'Contraseña actual', 'current-password');
    body.appendChild(actual.wrap);
  }
  const nueva = myPassField('Contraseña nueva', 'new-password');
  const repetir = myPassField('Repite la contraseña nueva', 'new-password');
  body.append(nueva.wrap, repetir.wrap);
  body.appendChild(uiEl('div', 'myacct-hint',
    `Mínimo ${MY_PASS_MIN} caracteres. Que sea algo que solo tú sepas. Al guardarla se cierra tu sesión en otros equipos (aquí sigues dentro).`));

  const saved = await uiDialog({
    title: forced ? 'Crea tu contraseña' : hasPass ? 'Cambiar mi contraseña' : 'Crear mi contraseña',
    message: forced ? 'Entraste con una clave temporal. Antes de seguir, ponle a tu cuenta una contraseña propia.' : '',
    tone: forced ? 'warning' : 'info',
    body,
    confirmText: 'Guardar contraseña',
    cancelText: forced ? null : 'Cancelar',
    dismissible: !forced,
    focusEl: (actual || nueva).input,
    extraButton: forced ? { text: 'Cerrar sesión', onClick: myAccountForceLogout } : null,
    onConfirm: async () => {
      const cur = knownCurrent !== null ? knownCurrent : (actual ? actual.input.value : null);
      const n = nueva.input.value;
      if (actual && !cur) return 'Escribe tu contraseña actual.';
      if (n.length < MY_PASS_MIN) return `La contraseña nueva debe tener al menos ${MY_PASS_MIN} caracteres.`;
      if (n !== n.trim()) return 'La contraseña nueva no puede empezar ni terminar con espacios.';
      if (n !== repetir.input.value) return 'Las dos contraseñas nuevas no coinciden.';
      if (cur && n === cur) return 'La contraseña nueva tiene que ser distinta a la actual.';
      try {
        const problem = await sbRpc('app_change_my_password', { p_actual: cur, p_nueva: n });
        return problem || null;
      } catch (err) {
        return (err && err.message) || 'No se pudo guardar la contraseña, intenta de nuevo.';
      }
    },
  });

  if (!saved) return false;
  myLoginPassword = null;
  await myAccountLoad();
  await uiAlert('Listo, tu contraseña quedó guardada. Úsala la próxima vez que inicies sesión.', { title: 'Contraseña guardada', tone: 'success' });
  return true;
}

/* Salir sin pasar por el "¿Cerrar sesión?" (ese modal quedaría en cola detrás del obligatorio) */
async function myAccountForceLogout() {
  try { await sbRpc('app_logout'); } catch (e) { /* el token vence solo */ }
  clearSession();
  location.reload();
}
