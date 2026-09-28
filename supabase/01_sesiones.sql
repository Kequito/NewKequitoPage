-- ══════════════════════════════════════════════════════════════════════
--  PASO 4 · SCRIPT 1 de 2 — SESIONES CON TOKEN (solo AGREGA cosas)
--
--  ✅ Seguro de correr YA: no borra ni bloquea nada. La página actual sigue
--     funcionando igual; esto solo prepara las piezas que usará la página nueva.
--  ✅ Se puede correr más de una vez sin problema.
--
--  Qué crea:
--    · dt_auth_sessions  → tabla de sesiones (guarda el HASH del token, nunca el token)
--    · app_login()       → reemplaza el login: devuelve un token de 12 h
--    · app_logout()      → cierra la sesión en el servidor
--    · app_role()        → dice el cargo real de quien hace cada consulta (lo usan las políticas)
--    · acct_create / acct_update / acct_delete → gestión de cuentas, SOLO Supervisor
--
--  Reglas de login (opción B acordada):
--    · Con contraseña guardada → hay que darla bien.
--    · Team Leader sin contraseña → entra solo eligiendo su nombre (como hoy).
--    · Supervisor sin contraseña → NO entra (si no, cualquiera sería Supervisor).
-- ══════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto with schema extensions;

-- ── Tabla de sesiones ──
create table if not exists public.dt_auth_sessions (
  token_hash text primary key,                  -- sha256 del token; el token real solo lo tiene el navegador
  nombre     text        not null,
  cargo      text        not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists dt_auth_sessions_expires_idx on public.dt_auth_sessions (expires_at);

-- Nadie la lee ni escribe desde afuera: solo las funciones de abajo (security definer)
alter table public.dt_auth_sessions enable row level security;
revoke all on public.dt_auth_sessions from anon, authenticated;


-- ── Hash del token que viene en el header x-session-token de la consulta actual ──
create or replace function public.app_current_token_hash()
returns text
language sql stable
set search_path = public, extensions
as $$
  select encode(extensions.digest(
    coalesce(nullif(current_setting('request.headers', true), '')::json ->> 'x-session-token', ''),
    'sha256'), 'hex')
$$;

-- ── Cargo real de quien consulta: 'supervisor' | 'team leader' | null ──
-- Se cruza con dt_session en cada consulta: si a alguien le cambian el cargo o le
-- borran la cuenta, sus sesiones abiertas dejan de valer al instante.
create or replace function public.app_role()
returns text
language sql stable security definer
set search_path = public, extensions
as $$
  select lower(trim(u."CARGO"))
  from public.dt_auth_sessions s
  join public.dt_session u
    on u."NOMBRE" = s.nombre
   and lower(trim(u."CARGO")) = lower(trim(s.cargo))
  where s.token_hash = public.app_current_token_hash()
    and s.expires_at > now()
  limit 1
$$;

create or replace function public.app_is_supervisor()
returns boolean language sql stable
set search_path = public
as $$ select coalesce(public.app_role() = 'supervisor', false) $$;

create or replace function public.app_is_editor()   -- Team Leader o Supervisor
returns boolean language sql stable
set search_path = public
as $$ select coalesce(public.app_role() in ('supervisor', 'team leader'), false) $$;


-- ── Login: devuelve el token + datos del usuario, o NADA si no corresponde ──
drop function if exists public.app_login(text, text);
create function public.app_login(p_nombre text, p_password text default null)
returns table (token text, nombre text, perop1am text, cargo text, genero text, expires_at timestamptz)
language plpgsql volatile security definer
set search_path = public, extensions
as $$
#variable_conflict use_column
declare
  u       public.dt_session%rowtype;
  v_token text;
  v_exp   timestamptz := now() + interval '12 hours';
begin
  select * into u from public.dt_session where "NOMBRE" = p_nombre limit 1;
  if not found then return; end if;

  if coalesce(u.clave_hash, '') <> '' then
    if p_password is null or extensions.crypt(p_password, u.clave_hash) <> u.clave_hash then
      return;                                            -- contraseña incorrecta
    end if;
  elsif lower(trim(u."CARGO")) = 'supervisor' then
    return;                                              -- Supervisor sin contraseña: no entra
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.dt_auth_sessions (token_hash, nombre, cargo, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), u."NOMBRE", u."CARGO", v_exp);

  delete from public.dt_auth_sessions where expires_at < now() - interval '1 day';  -- limpieza

  return query select v_token, u."NOMBRE", u."PEROP1AM", u."CARGO", u."GENERO", v_exp;
end
$$;

-- ── Logout: invalida el token actual ──
create or replace function public.app_logout()
returns void
language sql volatile security definer
set search_path = public, extensions
as $$
  delete from public.dt_auth_sessions where token_hash = public.app_current_token_hash()
$$;


-- ── Gestión de Cuentas — todas exigen un token de Supervisor ──
create or replace function public.acct_create(p_nombre text, p_perop1am text, p_cargo text, p_genero text, p_password text default null)
returns void
language plpgsql volatile security definer
set search_path = public, extensions
as $$
begin
  if not public.app_is_supervisor() then raise exception 'Solo un Supervisor puede crear cuentas' using errcode = '42501'; end if;
  if coalesce(trim(p_nombre), '') = '' then raise exception 'El nombre es obligatorio'; end if;
  insert into public.dt_session ("NOMBRE", "PEROP1AM", "CARGO", "GENERO", clave_hash)
  values (trim(p_nombre), p_perop1am, p_cargo, p_genero,
          case when coalesce(p_password, '') = '' then null
               else extensions.crypt(p_password, extensions.gen_salt('bf', 8)) end);
end
$$;

create or replace function public.acct_update(p_nombre_original text, p_nombre text, p_perop1am text, p_cargo text, p_genero text)
returns void
language plpgsql volatile security definer
set search_path = public, extensions
as $$
begin
  if not public.app_is_supervisor() then raise exception 'Solo un Supervisor puede editar cuentas' using errcode = '42501'; end if;
  if coalesce(trim(p_nombre), '') = '' then raise exception 'El nombre es obligatorio'; end if;
  update public.dt_session
     set "NOMBRE" = trim(p_nombre), "PEROP1AM" = p_perop1am, "CARGO" = p_cargo, "GENERO" = p_genero
   where "NOMBRE" = p_nombre_original;
  if not found then raise exception 'No existe la cuenta "%"', p_nombre_original; end if;
  -- Si cambió el nombre, las sesiones abiertas lo siguen. Si cambió el CARGO, dejan de valer
  -- solas (app_role() exige que el cargo de la sesión coincida): tendrá que volver a entrar.
  update public.dt_auth_sessions set nombre = trim(p_nombre) where nombre = p_nombre_original;
end
$$;

create or replace function public.acct_delete(p_nombre text)
returns void
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare v_me text;
begin
  if not public.app_is_supervisor() then raise exception 'Solo un Supervisor puede eliminar cuentas' using errcode = '42501'; end if;
  select s.nombre into v_me from public.dt_auth_sessions s where s.token_hash = public.app_current_token_hash();
  if v_me = p_nombre then raise exception 'No puedes eliminar tu propia cuenta'; end if;
  delete from public.dt_session where "NOMBRE" = p_nombre;
  delete from public.dt_auth_sessions where nombre = p_nombre;
end
$$;


-- ── Quién puede llamar a cada función ──
revoke all on function public.app_current_token_hash()                         from public;
revoke all on function public.app_role()                                       from public;
revoke all on function public.app_is_supervisor()                              from public;
revoke all on function public.app_is_editor()                                  from public;
revoke all on function public.app_login(text, text)                            from public;
revoke all on function public.app_logout()                                     from public;
revoke all on function public.acct_create(text, text, text, text, text)        from public;
revoke all on function public.acct_update(text, text, text, text, text)        from public;
revoke all on function public.acct_delete(text)                                from public;

grant execute on function public.app_current_token_hash()                      to anon, authenticated;
grant execute on function public.app_role()                                    to anon, authenticated;
grant execute on function public.app_is_supervisor()                           to anon, authenticated;
grant execute on function public.app_is_editor()                               to anon, authenticated;
grant execute on function public.app_login(text, text)                         to anon, authenticated;
grant execute on function public.app_logout()                                  to anon, authenticated;
grant execute on function public.acct_create(text, text, text, text, text)     to anon, authenticated;
grant execute on function public.acct_update(text, text, text, text, text)     to anon, authenticated;
grant execute on function public.acct_delete(text)                             to anon, authenticated;

-- ── Comprobación final: debe mostrar las 9 funciones ──
select p.proname as funcion_creada
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('app_current_token_hash','app_role','app_is_supervisor','app_is_editor',
                    'app_login','app_logout','acct_create','acct_update','acct_delete')
order by 1;
