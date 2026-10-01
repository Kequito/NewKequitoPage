-- ══════════════════════════════════════════════════════════════════════
--  SCRIPT 06 — LÍMITE DE INTENTOS DE CONTRASEÑA
--
--  ✅ Se puede correr antes o después de publicar la página (es compatible con
--     las dos). Se puede correr más de una vez sin problema. No borra datos.
--
--  Regla:
--    · 5 contraseñas incorrectas seguidas (en menos de 15 minutos) → esa cuenta
--      queda BLOQUEADA 10 minutos, aunque después pongan la contraseña correcta.
--    · Entrar bien reinicia el contador.
--    · Solo aplica a cuentas CON contraseña (las que no tienen no se pueden adivinar).
--    · Si a una cuenta le cambian la contraseña desde Gestión de Cuentas, se desbloquea.
--
--  Qué crea / cambia:
--    · dt_login_guard      → contador de fallos y hora de desbloqueo por cuenta
--    · app_login()         → misma función de siempre + el bloqueo
--    · set_user_password() → misma de siempre + desbloquea la cuenta
-- ══════════════════════════════════════════════════════════════════════

create table if not exists public.dt_login_guard (
  cuenta          text primary key,        -- "NOMBRE" de dt_session
  fallos          int  not null default 0, -- fallos seguidos (se reinicia al entrar bien o al bloquear)
  ultimo_fallo    timestamptz,
  bloqueado_hasta timestamptz
);
-- Nadie la lee ni escribe desde afuera: solo las funciones de abajo (security definer)
alter table public.dt_login_guard enable row level security;
revoke all on public.dt_login_guard from anon, authenticated;


create or replace function public.app_login(p_nombre text, p_password text default null)
returns table (token text, nombre text, perop1am text, cargo text, genero text, expires_at timestamptz)
language plpgsql volatile security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  c_max_fallos constant int      := 5;
  c_ventana    constant interval := interval '15 minutes';   -- fallos más viejos que esto no cuentan
  c_bloqueo    constant interval := interval '10 minutes';
  u        public.dt_session%rowtype;
  g        public.dt_login_guard%rowtype;
  v_hay_g  boolean;
  v_fallos int;
  v_min    int;
  v_token  text;
  v_exp    timestamptz := now() + interval '12 hours';
begin
  select * into u from public.dt_session where "NOMBRE" = p_nombre limit 1;
  if not found then return; end if;

  if coalesce(u.clave_hash, '') <> '' then
    select * into g from public.dt_login_guard where cuenta = u."NOMBRE";
    v_hay_g := found;

    -- ¿Bloqueada? Se avisa con un mensaje (la página lo muestra tal cual)
    if v_hay_g and g.bloqueado_hasta is not null and g.bloqueado_hasta > now() then
      v_min := greatest(1, ceil(extract(epoch from (g.bloqueado_hasta - now())) / 60)::int);
      raise exception 'Demasiados intentos fallidos. Por seguridad, esta cuenta quedó bloqueada: intenta de nuevo en % minuto%.',
        v_min, case when v_min = 1 then '' else 's' end;
    end if;

    if p_password is null or extensions.crypt(p_password, u.clave_hash) <> u.clave_hash then
      -- Contraseña incorrecta: sumar el fallo (y bloquear al llegar al máximo).
      -- Ojo: se sale con "return", no con error, para que el contador SÍ se guarde.
      v_fallos := case when v_hay_g and g.ultimo_fallo > now() - c_ventana then g.fallos + 1 else 1 end;
      insert into public.dt_login_guard (cuenta, fallos, ultimo_fallo, bloqueado_hasta)
      values (u."NOMBRE",
              case when v_fallos >= c_max_fallos then 0 else v_fallos end,
              now(),
              case when v_fallos >= c_max_fallos then now() + c_bloqueo else null end)
      on conflict (cuenta) do update
        set fallos = excluded.fallos, ultimo_fallo = excluded.ultimo_fallo, bloqueado_hasta = excluded.bloqueado_hasta;
      return;
    end if;

    delete from public.dt_login_guard where cuenta = u."NOMBRE";   -- entró bien: contador a cero
  elsif lower(trim(u."CARGO")) = 'supervisor' then
    return;                                                      -- Supervisor sin contraseña: no entra
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.dt_auth_sessions (token_hash, nombre, cargo, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), u."NOMBRE", u."CARGO", v_exp);

  delete from public.dt_auth_sessions where expires_at < now() - interval '1 day';  -- limpieza

  return query select v_token, u."NOMBRE", u."PEROP1AM", u."CARGO", u."GENERO", v_exp;
end
$$;


-- Igual que en 03_permisos.sql, más: cambiar la contraseña desbloquea la cuenta
create or replace function public.set_user_password(p_nombre text, p_new_password text default null)
returns void language plpgsql volatile security definer
set search_path = public, extensions as $$
declare v_cargo text;
begin
  if not public.app_has_perm('accounts.manage') then
    raise exception 'No tienes permiso para cambiar contraseñas' using errcode = '42501';
  end if;
  select lower(trim("CARGO")) into v_cargo from public.dt_session where "NOMBRE" = p_nombre;
  if not found then raise exception 'No existe la cuenta "%"', p_nombre; end if;
  if coalesce(p_new_password, '') = '' and v_cargo = 'supervisor' then
    raise exception 'Un Supervisor no puede quedar sin contraseña';
  end if;
  update public.dt_session
     set clave_hash = case when coalesce(p_new_password, '') = '' then null
                           else extensions.crypt(p_new_password, extensions.gen_salt('bf', 8)) end
   where "NOMBRE" = p_nombre;
  perform public.app_perm_guard();   -- antes de cerrar sesiones: quitar una clave quita permisos sensibles
  delete from public.dt_auth_sessions where nombre = p_nombre;
  delete from public.dt_login_guard where cuenta = p_nombre;
end
$$;


-- Mismos accesos de siempre (create or replace los conserva; esto es por si acaso)
revoke all on function public.app_login(text, text) from public;
grant execute on function public.app_login(text, text) to anon, authenticated;
revoke all on function public.set_user_password(text, text) from public;
grant execute on function public.set_user_password(text, text) to anon, authenticated;


-- ── Comprobación final: las 3 filas deben decir OK ──
select 'Tabla de intentos creada y cerrada' as chequeo,
       case when (select relrowsecurity from pg_class where oid = 'public.dt_login_guard'::regclass)
            then 'OK' else 'REVISAR' end as resultado
union all
select 'Login con bloqueo',
       case when (select prosrc from pg_proc where proname = 'app_login' and pronamespace = 'public'::regnamespace) like '%dt_login_guard%'
            then 'OK' else 'REVISAR' end
union all
select 'Cambiar contraseña desbloquea',
       case when (select prosrc from pg_proc where proname = 'set_user_password' and pronamespace = 'public'::regnamespace) like '%dt_login_guard%'
            then 'OK' else 'REVISAR' end;
