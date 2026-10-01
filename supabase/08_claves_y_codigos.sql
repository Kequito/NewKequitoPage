-- ══════════════════════════════════════════════════════════════════════
--  SCRIPT 08 — CONTRASEÑAS PROPIAS, CLAVE TEMPORAL Y CÓDIGO DE CUENTA
--
--  ✅ Correr ANTES de publicar la página nueva. La página actual sigue funcionando
--     igual con esto corrido (solo agrega columnas y funciones; app_login devuelve 2 datos más).
--  ✅ Se puede correr más de una vez sin problema. No borra datos.
--
--  Qué hace:
--    · Código único por cuenta: GC-0001, GC-0002… Se crea solo al crear la cuenta, NUNCA cambia
--      (ni al renombrar ni al cambiar de cargo) y no se reutiliza aunque se borre la cuenta.
--      Las cuentas que ya existen reciben el suyo ahora (Supervisores, luego TL, luego Operadores, por nombre).
--    · "Clave temporal": un Supervisor (permiso accounts.manage) genera una clave al azar para
--      cualquier cuenta; la cuenta queda marcada para cambiarla al entrar.
--    · Cada quien cambia SU contraseña sabiendo la actual (los intentos fallidos cuentan para el
--      bloqueo de 5 intentos del script 06). Al cambiarla se cierran sus sesiones en otros equipos.
--    · Gestión de Cuentas ve el estado de cada clave (propia / temporal / bloqueada) y puede desbloquear.
--  Las contraseñas siguen guardándose solo como hash (bcrypt): nadie puede verlas, ni Supabase.
-- ══════════════════════════════════════════════════════════════════════

-- ── Columnas nuevas en dt_session ──
create sequence if not exists public.dt_session_codigo_seq;

alter table public.dt_session add column if not exists codigo            text;
alter table public.dt_session add column if not exists clave_temporal    boolean not null default false;
alter table public.dt_session add column if not exists clave_cambiada_at timestamptz;

-- Códigos para las cuentas que ya existen (solo las que no tienen)
do $$
declare r record;
begin
  for r in
    select "NOMBRE" from public.dt_session
    where codigo is null
    order by case lower(trim("CARGO")) when 'supervisor' then 1 when 'team leader' then 2 when 'operador' then 3 else 4 end,
             "NOMBRE"
  loop
    update public.dt_session
       set codigo = 'GC-' || lpad(nextval('public.dt_session_codigo_seq')::text, 4, '0')
     where "NOMBRE" = r."NOMBRE" and codigo is null;
  end loop;
end
$$;

-- Cuentas nuevas: el código se pone solo
alter table public.dt_session
  alter column codigo set default ('GC-' || lpad(nextval('public.dt_session_codigo_seq')::text, 4, '0'));
alter table public.dt_session alter column codigo set not null;
create unique index if not exists dt_session_codigo_key on public.dt_session (codigo);

-- El código no se puede cambiar nunca
create or replace function public.dt_session_codigo_fijo()
returns trigger language plpgsql as $$
begin
  if new.codigo is distinct from old.codigo then
    raise exception 'El código de una cuenta (%) no se puede cambiar', old.codigo;
  end if;
  return new;
end
$$;
drop trigger if exists dt_session_codigo_fijo on public.dt_session;
create trigger dt_session_codigo_fijo before update on public.dt_session
  for each row execute function public.dt_session_codigo_fijo();


-- ── Login: igual que el del script 06 (con bloqueo), + devuelve el código y si debe cambiar la clave ──
drop function if exists public.app_login(text, text);
create function public.app_login(p_nombre text, p_password text default null)
returns table (token text, nombre text, perop1am text, cargo text, genero text, expires_at timestamptz,
               codigo text, debe_cambiar boolean)
language plpgsql volatile security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  c_max_fallos constant int      := 5;
  c_ventana    constant interval := interval '15 minutes';
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

    if v_hay_g and g.bloqueado_hasta is not null and g.bloqueado_hasta > now() then
      v_min := greatest(1, ceil(extract(epoch from (g.bloqueado_hasta - now())) / 60)::int);
      raise exception 'Demasiados intentos fallidos. Por seguridad, esta cuenta quedó bloqueada: intenta de nuevo en % minuto%.',
        v_min, case when v_min = 1 then '' else 's' end;
    end if;

    if p_password is null or extensions.crypt(p_password, u.clave_hash) <> u.clave_hash then
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

    delete from public.dt_login_guard where cuenta = u."NOMBRE";
  elsif lower(trim(u."CARGO")) = 'supervisor' then
    return;
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.dt_auth_sessions (token_hash, nombre, cargo, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), u."NOMBRE", u."CARGO", v_exp);

  delete from public.dt_auth_sessions where expires_at < now() - interval '1 day';

  return query select v_token, u."NOMBRE", u."PEROP1AM", u."CARGO", u."GENERO", v_exp,
                      u.codigo, (u.clave_temporal and coalesce(u.clave_hash, '') <> '');
end
$$;


-- ── Mi cuenta: datos propios (para "Mi cuenta" y para saber si toca cambiar la clave temporal) ──
create or replace function public.app_my_account()
returns table (nombre text, codigo text, perop1am text, cargo text,
               tiene_clave boolean, debe_cambiar boolean, clave_cambiada_at timestamptz)
language sql stable security definer
set search_path = public as $$
  select u."NOMBRE", u.codigo, u."PEROP1AM", u."CARGO",
         coalesce(u.clave_hash, '') <> '',
         u.clave_temporal and coalesce(u.clave_hash, '') <> '',
         u.clave_cambiada_at
  from public.dt_session u
  where public.app_role() is not null and u."NOMBRE" = public.app_current_nombre()
$$;


-- ── Cambiar MI contraseña ──
-- Devuelve NULL si salió bien, o un texto con el motivo (contraseña actual incorrecta / bloqueada).
-- No lanza error en la contraseña incorrecta a propósito: así el intento fallido SÍ queda contado.
-- Si la cuenta todavía no tiene contraseña, se puede poner una sin "actual" (ya entró eligiendo su nombre).
create or replace function public.app_change_my_password(p_actual text, p_nueva text)
returns text language plpgsql volatile security definer
set search_path = public, extensions as $$
declare
  c_max_fallos constant int      := 5;
  c_ventana    constant interval := interval '15 minutes';
  c_bloqueo    constant interval := interval '10 minutes';
  c_min_largo  constant int      := 6;
  v_me     text := public.app_current_nombre();
  u        public.dt_session%rowtype;
  g        public.dt_login_guard%rowtype;
  v_fallos int;
  v_min    int;
begin
  if v_me is null or public.app_role() is null then
    raise exception 'Tu sesión ya no es válida. Vuelve a iniciar sesión.' using errcode = '42501';
  end if;
  select * into u from public.dt_session where "NOMBRE" = v_me;

  if length(coalesce(p_nueva, '')) < c_min_largo then
    raise exception 'La contraseña nueva debe tener al menos % caracteres.', c_min_largo;
  end if;
  if p_nueva ~ '^\s|\s$' then
    raise exception 'La contraseña nueva no puede empezar ni terminar con espacios.';
  end if;

  if coalesce(u.clave_hash, '') <> '' then
    select * into g from public.dt_login_guard where cuenta = v_me;
    if found and g.bloqueado_hasta is not null and g.bloqueado_hasta > now() then
      v_min := greatest(1, ceil(extract(epoch from (g.bloqueado_hasta - now())) / 60)::int);
      return format('Demasiados intentos fallidos. Intenta de nuevo en %s minuto%s.', v_min, case when v_min = 1 then '' else 's' end);
    end if;

    if p_actual is null or extensions.crypt(p_actual, u.clave_hash) <> u.clave_hash then
      v_fallos := case when found and g.ultimo_fallo > now() - c_ventana then g.fallos + 1 else 1 end;
      insert into public.dt_login_guard (cuenta, fallos, ultimo_fallo, bloqueado_hasta)
      values (v_me,
              case when v_fallos >= c_max_fallos then 0 else v_fallos end,
              now(),
              case when v_fallos >= c_max_fallos then now() + c_bloqueo else null end)
      on conflict (cuenta) do update
        set fallos = excluded.fallos, ultimo_fallo = excluded.ultimo_fallo, bloqueado_hasta = excluded.bloqueado_hasta;
      return case when v_fallos >= c_max_fallos
                  then 'Contraseña actual incorrecta. Por seguridad la cuenta quedó bloqueada 10 minutos.'
                  else 'La contraseña actual no es correcta.' end;
    end if;

    if extensions.crypt(p_nueva, u.clave_hash) = u.clave_hash then
      raise exception 'La contraseña nueva tiene que ser distinta a la actual.';
    end if;
  end if;

  update public.dt_session
     set clave_hash = extensions.crypt(p_nueva, extensions.gen_salt('bf', 8)),
         clave_temporal = false,
         clave_cambiada_at = now()
   where "NOMBRE" = v_me;
  delete from public.dt_login_guard where cuenta = v_me;
  -- Se cierran las sesiones en OTROS equipos; la actual sigue abierta
  delete from public.dt_auth_sessions where nombre = v_me and token_hash <> public.app_current_token_hash();
  return null;
end
$$;


-- ── Clave temporal (Gestión de Cuentas) — devuelve la clave generada, que se muestra UNA vez ──
create or replace function public.acct_reset_password(p_nombre text)
returns text language plpgsql volatile security definer
set search_path = public, extensions as $$
declare
  c_letras constant text := 'abcdefghjkmnpqrstuvwxyz23456789';   -- sin 0/o, 1/l/i: no se confunden al dictarla
  v_bytes bytea := extensions.gen_random_bytes(8);
  v_clave text := '';
  i int;
begin
  if not public.app_has_perm('accounts.manage') then
    raise exception 'No tienes permiso para cambiar contraseñas' using errcode = '42501';
  end if;
  if public.app_current_nombre() = p_nombre then
    raise exception 'Tu propia contraseña se cambia desde "Mi cuenta" (clic en tu nombre, arriba a la derecha).';
  end if;
  if not exists (select 1 from public.dt_session where "NOMBRE" = p_nombre) then
    raise exception 'No existe la cuenta "%"', p_nombre;
  end if;

  for i in 0..7 loop
    v_clave := v_clave || substr(c_letras, (get_byte(v_bytes, i) % length(c_letras)) + 1, 1);
    if i = 3 then v_clave := v_clave || '-'; end if;
  end loop;

  update public.dt_session
     set clave_hash = extensions.crypt(v_clave, extensions.gen_salt('bf', 8)),
         clave_temporal = true,
         clave_cambiada_at = now()
   where "NOMBRE" = p_nombre;
  delete from public.dt_auth_sessions where nombre = p_nombre;
  delete from public.dt_login_guard where cuenta = p_nombre;
  return v_clave;
end
$$;


-- ── Quitar la contraseña / poner una a mano (se mantiene, por compatibilidad) ──
-- Igual que en el script 06, + deja registrado el estado de la clave.
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
                           else extensions.crypt(p_new_password, extensions.gen_salt('bf', 8)) end,
         -- Una clave que puso otra persona cuenta como temporal: el dueño debe cambiarla al entrar
         clave_temporal = coalesce(p_new_password, '') <> '' and public.app_current_nombre() is distinct from p_nombre,
         clave_cambiada_at = now()
   where "NOMBRE" = p_nombre;
  perform public.app_perm_guard();
  delete from public.dt_auth_sessions where nombre = p_nombre;
  delete from public.dt_login_guard where cuenta = p_nombre;
end
$$;


-- ── Crear cuenta: igual que antes; si se le pone contraseña al crearla, queda como temporal ──
create or replace function public.acct_create(p_nombre text, p_perop1am text, p_cargo text, p_genero text, p_password text default null)
returns void language plpgsql volatile security definer
set search_path = public, extensions as $$
begin
  if not public.app_has_perm('accounts.manage') then raise exception 'No tienes permiso para crear cuentas' using errcode = '42501'; end if;
  if coalesce(trim(p_nombre), '') = '' then raise exception 'El nombre es obligatorio'; end if;
  insert into public.dt_session ("NOMBRE", "PEROP1AM", "CARGO", "GENERO", clave_hash, clave_temporal, clave_cambiada_at)
  values (trim(p_nombre), p_perop1am, p_cargo, p_genero,
          case when coalesce(p_password, '') = '' then null
               else extensions.crypt(p_password, extensions.gen_salt('bf', 8)) end,
          coalesce(p_password, '') <> '',
          case when coalesce(p_password, '') = '' then null else now() end);
end
$$;


-- ── Estado de las claves de todas las cuentas (Gestión de Cuentas) ──
create or replace function public.acct_status_list()
returns table (nombre text, codigo text, tiene_clave boolean, clave_temporal boolean,
               clave_cambiada_at timestamptz, bloqueado_hasta timestamptz)
language plpgsql stable security definer
set search_path = public as $$
begin
  if not public.app_has_perm('accounts.manage') then
    raise exception 'No tienes permiso para ver las cuentas' using errcode = '42501';
  end if;
  return query
    select u."NOMBRE", u.codigo, coalesce(u.clave_hash, '') <> '', u.clave_temporal, u.clave_cambiada_at,
           case when g.bloqueado_hasta > now() then g.bloqueado_hasta end
    from public.dt_session u
    left join public.dt_login_guard g on g.cuenta = u."NOMBRE"
    order by u.codigo;
end
$$;


-- ── Desbloquear una cuenta bloqueada por intentos fallidos ──
create or replace function public.acct_unlock(p_nombre text)
returns void language plpgsql volatile security definer
set search_path = public as $$
begin
  if not public.app_has_perm('accounts.manage') then
    raise exception 'No tienes permiso para desbloquear cuentas' using errcode = '42501';
  end if;
  delete from public.dt_login_guard where cuenta = p_nombre;
end
$$;


-- ── Quién puede llamar a cada función (cada una revisa por dentro la sesión y el permiso) ──
do $$
declare f text;
begin
  foreach f in array array[
    'app_login(text, text)', 'app_my_account()', 'app_change_my_password(text, text)',
    'acct_reset_password(text)', 'set_user_password(text, text)',
    'acct_create(text, text, text, text, text)', 'acct_status_list()', 'acct_unlock(text)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end
$$;
revoke all on function public.dt_session_codigo_fijo() from public, anon, authenticated;


-- ── Comprobación final: todas las filas deben decir OK ──
select 'Todas las cuentas tienen código' as chequeo,
       case when not exists (select 1 from public.dt_session where codigo is null) then 'OK' else 'REVISAR' end as resultado
union all
select 'Códigos sin repetir',
       case when (select count(*) from public.dt_session) = (select count(distinct codigo) from public.dt_session) then 'OK' else 'REVISAR' end
union all
select 'Login devuelve código',
       case when (select pg_get_function_result(oid) from pg_proc where proname = 'app_login' and pronamespace = 'public'::regnamespace) like '%codigo%'
            then 'OK' else 'REVISAR' end
union all
select 'Login conserva el bloqueo por intentos',
       case when (select prosrc from pg_proc where proname = 'app_login' and pronamespace = 'public'::regnamespace) like '%dt_login_guard%'
            then 'OK' else 'REVISAR' end
union all
select 'Funciones nuevas creadas',
       case when (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
                  and proname in ('app_my_account', 'app_change_my_password', 'acct_reset_password', 'acct_status_list', 'acct_unlock')) = 5
            then 'OK' else 'REVISAR' end;
