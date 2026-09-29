-- ══════════════════════════════════════════════════════════════════════
--  PASO 5 · SCRIPT 03 — PERMISOS EDITABLES (por cargo y por cuenta) + cargo "Operador"
--
--  ✅ Correr ANTES de publicar la página nueva. Es compatible con la página actual:
--     los permisos iniciales de Supervisor y Team Leader son EXACTAMENTE los de hoy,
--     así que nada cambia hasta que alguien los edite desde Gestión de Cuentas.
--  ✅ Se puede correr más de una vez sin problema (no pisa permisos ya editados).
--  ↩  Para volver al esquema anterior: correr de nuevo 02_bloqueo.sql.
--
--  Qué hace:
--    · dt_role_permissions  → permisos de cada cargo (Supervisor, Team Leader, Operador).
--    · dt_session.permisos_extra → excepciones por cuenta: {"permiso": true|false}.
--    · Permisos SENSIBLES solo cuentan si la cuenta tiene contraseña (así, dárselos a una
--      cuenta sin clave no abre un hueco: cualquiera podría entrar eligiendo su nombre).
--    · Nadie puede quitarse a sí mismo "Gestión de Cuentas", y siempre queda al menos una
--      cuenta que pueda gestionar cuentas.
--    · Las políticas RLS pasan a revisar PERMISOS (no cargos fijos).
-- ══════════════════════════════════════════════════════════════════════

-- ── Catálogo (debe coincidir con PERM_CATALOG en js/core/permissions.js) ──
create or replace function public.app_all_perms()
returns text[] language sql immutable as $$
  select array[
    'view.dashboard','view.goodday','view.ops','view.opstoday','view.opslive',
    'view.reportes','view.recalls','view.leads','view.tl',
    'opstoday.upload','recalls.upload','recalls.review','recalls.compare','leads.save',
    'reportes.save','tl.manage','datalinks.edit','data.upload','accounts.manage','sidebar.manage'
  ]::text[]
$$;

-- Sensibles: solo valen en cuentas CON contraseña
create or replace function public.app_sensitive_perms()
returns text[] language sql immutable as $$
  select array['recalls.compare','reportes.save','tl.manage','datalinks.edit',
               'data.upload','accounts.manage','sidebar.manage']::text[]
$$;

-- ── Tablas ──
create table if not exists public.dt_role_permissions (
  role       text primary key,                 -- cargo en minúsculas: 'supervisor' | 'team leader' | 'operador'
  perms      text[] not null default '{}',
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.dt_role_permissions enable row level security;
revoke all on public.dt_role_permissions from anon, authenticated;   -- solo vía funciones

alter table public.dt_session add column if not exists permisos_extra jsonb not null default '{}'::jsonb;

-- Permisos iniciales = comportamiento actual (solo se insertan si el cargo todavía no existe)
insert into public.dt_role_permissions (role, perms, updated_by) values
  ('supervisor',  public.app_all_perms(), 'configuración inicial'),
  ('team leader', array['view.dashboard','view.goodday','view.ops','view.opstoday','view.opslive',
                        'view.reportes','view.recalls','view.leads','view.tl',
                        'opstoday.upload','recalls.upload','recalls.review','leads.save'], 'configuración inicial'),
  ('operador',    array['view.dashboard','view.goodday','view.opslive','view.recalls'], 'configuración inicial')
on conflict (role) do nothing;


-- ── Quién consulta (por su token), sin exigir que el cargo coincida ──
create or replace function public.app_current_nombre()
returns text language sql stable security definer
set search_path = public, extensions as $$
  select s.nombre from public.dt_auth_sessions s
  where s.token_hash = public.app_current_token_hash() and s.expires_at > now()
  limit 1
$$;

-- ── Permisos efectivos de una cuenta: cargo + excepciones, y sensibles solo con contraseña ──
create or replace function public.app_effective_perms(p_nombre text)
returns text[] language plpgsql stable security definer
set search_path = public as $$
declare
  u public.dt_session%rowtype;
  base text[];
  result text[];
  k text; v text;
begin
  select * into u from public.dt_session where "NOMBRE" = p_nombre limit 1;
  if not found then return '{}'; end if;

  select coalesce(r.perms, '{}') into base
  from public.dt_role_permissions r where r.role = lower(trim(u."CARGO"));
  result := coalesce(base, '{}');

  for k, v in select key, value from jsonb_each_text(coalesce(u.permisos_extra, '{}'::jsonb)) loop
    if not (k = any(public.app_all_perms())) then continue; end if;
    if v = 'true' and not (k = any(result)) then result := result || k;
    elsif v = 'false' then result := array_remove(result, k);
    end if;
  end loop;

  if coalesce(u.clave_hash, '') = '' then
    result := array(select p from unnest(result) p where not (p = any(public.app_sensitive_perms())));
  end if;
  return result;
end
$$;

-- Permisos de quien consulta. Exige sesión válida con el cargo vigente (app_role),
-- así un cambio de cargo invalida al instante los permisos de las sesiones abiertas.
create or replace function public.app_permissions()
returns text[] language sql stable security definer
set search_path = public as $$
  select case when public.app_role() is null then '{}'::text[]
              else public.app_effective_perms(public.app_current_nombre()) end
$$;

create or replace function public.app_has_perm(p_perm text)
returns boolean language sql stable
set search_path = public as $$
  select coalesce(p_perm = any(public.app_permissions()), false)
$$;

-- Para la página: mis permisos al entrar
create or replace function public.app_my_permissions()
returns text[] language sql stable
set search_path = public as $$ select public.app_permissions() $$;


-- ── Protección contra quedarse sin nadie que gestione cuentas ──
create or replace function public.app_perm_guard()
returns void language plpgsql security definer
set search_path = public as $$
declare v_me text;
begin
  if not exists (select 1 from public.dt_session s
                 where 'accounts.manage' = any(public.app_effective_perms(s."NOMBRE"))) then
    raise exception 'Tiene que quedar al menos una cuenta (con contraseña) que pueda gestionar cuentas.';
  end if;
  v_me := public.app_current_nombre();
  if v_me is not null and not ('accounts.manage' = any(public.app_effective_perms(v_me))) then
    raise exception 'No puedes quitarte a ti mismo el permiso de Gestión de Cuentas.';
  end if;
end
$$;

-- ── Leer toda la configuración (para la pantalla de Gestión de Cuentas) ──
create or replace function public.perm_get_all()
returns jsonb language plpgsql stable security definer
set search_path = public as $$
begin
  if not public.app_has_perm('accounts.manage') then
    raise exception 'No tienes permiso para ver los permisos' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'roles', (select coalesce(jsonb_agg(jsonb_build_object('role', role, 'perms', to_jsonb(perms),
                                                           'updated_at', updated_at, 'updated_by', updated_by)), '[]'::jsonb)
              from public.dt_role_permissions),
    'accounts', (select coalesce(jsonb_agg(jsonb_build_object(
                    'nombre', "NOMBRE", 'cargo', "CARGO", 'extra', coalesce(permisos_extra, '{}'::jsonb),
                    'has_pass', coalesce(clave_hash, '') <> '',
                    'effective', to_jsonb(public.app_effective_perms("NOMBRE")))), '[]'::jsonb)
                 from public.dt_session)
  );
end
$$;

-- ── Guardar permisos de un cargo ──
create or replace function public.perm_set_role(p_role text, p_perms text[])
returns void language plpgsql volatile security definer
set search_path = public as $$
declare v_role text := lower(trim(p_role));
begin
  if not public.app_has_perm('accounts.manage') then
    raise exception 'No tienes permiso para editar permisos' using errcode = '42501';
  end if;
  if v_role not in ('supervisor', 'team leader', 'operador') then raise exception 'Cargo desconocido: %', p_role; end if;
  if exists (select 1 from unnest(coalesce(p_perms, '{}')) p where not (p = any(public.app_all_perms()))) then
    raise exception 'Hay permisos desconocidos en la lista';
  end if;
  insert into public.dt_role_permissions (role, perms, updated_at, updated_by)
  values (v_role, array(select distinct unnest(coalesce(p_perms, '{}'))), now(), public.app_current_nombre())
  on conflict (role) do update set perms = excluded.perms, updated_at = now(), updated_by = excluded.updated_by;
  perform public.app_perm_guard();
end
$$;

-- ── Guardar excepciones de una cuenta: {"permiso": true|false}; {} = todo según cargo ──
create or replace function public.perm_set_account(p_nombre text, p_extra jsonb)
returns void language plpgsql volatile security definer
set search_path = public as $$
begin
  if not public.app_has_perm('accounts.manage') then
    raise exception 'No tienes permiso para editar permisos' using errcode = '42501';
  end if;
  if jsonb_typeof(coalesce(p_extra, '{}'::jsonb)) <> 'object' then raise exception 'Formato de permisos inválido'; end if;
  if exists (select 1 from jsonb_each(coalesce(p_extra, '{}'::jsonb)) e
             where not (e.key = any(public.app_all_perms())) or jsonb_typeof(e.value) <> 'boolean') then
    raise exception 'Hay permisos desconocidos o valores inválidos';
  end if;
  update public.dt_session set permisos_extra = coalesce(p_extra, '{}'::jsonb) where "NOMBRE" = p_nombre;
  if not found then raise exception 'No existe la cuenta "%"', p_nombre; end if;
  perform public.app_perm_guard();
end
$$;


-- ── Gestión de Cuentas: ahora por PERMISO "accounts.manage" (antes: cargo Supervisor) ──
create or replace function public.acct_create(p_nombre text, p_perop1am text, p_cargo text, p_genero text, p_password text default null)
returns void language plpgsql volatile security definer
set search_path = public, extensions as $$
begin
  if not public.app_has_perm('accounts.manage') then raise exception 'No tienes permiso para crear cuentas' using errcode = '42501'; end if;
  if coalesce(trim(p_nombre), '') = '' then raise exception 'El nombre es obligatorio'; end if;
  insert into public.dt_session ("NOMBRE", "PEROP1AM", "CARGO", "GENERO", clave_hash)
  values (trim(p_nombre), p_perop1am, p_cargo, p_genero,
          case when coalesce(p_password, '') = '' then null
               else extensions.crypt(p_password, extensions.gen_salt('bf', 8)) end);
end
$$;

create or replace function public.acct_update(p_nombre_original text, p_nombre text, p_perop1am text, p_cargo text, p_genero text)
returns void language plpgsql volatile security definer
set search_path = public, extensions as $$
begin
  if not public.app_has_perm('accounts.manage') then raise exception 'No tienes permiso para editar cuentas' using errcode = '42501'; end if;
  if coalesce(trim(p_nombre), '') = '' then raise exception 'El nombre es obligatorio'; end if;
  update public.dt_session
     set "NOMBRE" = trim(p_nombre), "PEROP1AM" = p_perop1am, "CARGO" = p_cargo, "GENERO" = p_genero
   where "NOMBRE" = p_nombre_original;
  if not found then raise exception 'No existe la cuenta "%"', p_nombre_original; end if;
  update public.dt_auth_sessions set nombre = trim(p_nombre) where nombre = p_nombre_original;
  perform public.app_perm_guard();
end
$$;

create or replace function public.acct_delete(p_nombre text)
returns void language plpgsql volatile security definer
set search_path = public, extensions as $$
begin
  if not public.app_has_perm('accounts.manage') then raise exception 'No tienes permiso para eliminar cuentas' using errcode = '42501'; end if;
  if public.app_current_nombre() = p_nombre then raise exception 'No puedes eliminar tu propia cuenta'; end if;
  delete from public.dt_session where "NOMBRE" = p_nombre;
  delete from public.dt_auth_sessions where nombre = p_nombre;
  perform public.app_perm_guard();
end
$$;

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
end
$$;


-- ── Políticas RLS por PERMISO ──
-- Leer: cualquier sesión válida (Supervisor, Team Leader u Operador).
-- Escribir: según el permiso de la acción que usa esa tabla en la página.
do $$
declare
  -- tabla → [insertar, actualizar, borrar] (expresiones SQL)
  reglas jsonb := jsonb_build_object(
    'dt_ops_today',         jsonb_build_array('opstoday.upload', 'opstoday.upload', 'opstoday.upload'),
    'dt_ops_today_history', jsonb_build_array('opstoday.upload', 'opstoday.upload', 'opstoday.upload'),
    'dt_leads_campana',     jsonb_build_array('leads.save', 'leads.save', 'leads.save'),
    'dt_recalls',           jsonb_build_array('recalls.upload', 'recalls.compare', 'recalls.upload|recalls.compare'),
    'dt_recalls_alerts',    jsonb_build_array('recalls.upload', 'recalls.review|recalls.compare', 'recalls.review'),
    'dt_recalls_excluded',  jsonb_build_array('recalls.compare', 'recalls.compare', 'recalls.compare'),
    'dt_dis',               jsonb_build_array('data.upload', 'data.upload', 'data.upload'),
    'dt_ops',               jsonb_build_array('data.upload', 'data.upload', 'data.upload'),
    'dt_tl_stats',          jsonb_build_array('data.upload', 'data.upload', 'data.upload'),
    'dt_reportes_ventas',   jsonb_build_array('reportes.save', 'reportes.save', 'reportes.save'),
    'dt_reportes_extra',    jsonb_build_array('reportes.save', 'reportes.save', 'reportes.save'),
    'dt_tl_history',        jsonb_build_array('tl.manage', 'tl.manage', 'tl.manage'),
    'dt_tl_banned',         jsonb_build_array('tl.manage', 'tl.manage', 'tl.manage'),
    'dt_data_links',        jsonb_build_array('datalinks.edit', 'datalinks.edit', 'datalinks.edit'),
    'dt_sidebar_config',    jsonb_build_array('sidebar.manage', 'sidebar.manage', 'sidebar.manage')
  );
  t text; pol record; ins text; upd text; del text;
begin
  for t in select jsonb_object_keys(reglas) loop
    if to_regclass(format('public.%I', t)) is null then continue; end if;   -- tabla todavía no creada (ej. 04 sin correr)
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('alter table public.%I enable row level security', t);

    -- "a|b" → (select app_has_perm('a')) or (select app_has_perm('b')) — una evaluación por consulta
    select string_agg(format('(select public.app_has_perm(%L))', p), ' or ') into ins from unnest(string_to_array(reglas->t->>0, '|')) p;
    select string_agg(format('(select public.app_has_perm(%L))', p), ' or ') into upd from unnest(string_to_array(reglas->t->>1, '|')) p;
    select string_agg(format('(select public.app_has_perm(%L))', p), ' or ') into del from unnest(string_to_array(reglas->t->>2, '|')) p;

    execute format('create policy app_leer on public.%I for select to anon, authenticated using ((select public.app_role()) is not null)', t);
    execute format('create policy app_insertar on public.%I for insert to anon, authenticated with check (%s)', t, ins);
    execute format('create policy app_actualizar on public.%I for update to anon, authenticated using (%s) with check (%s)', t, upd, upd);
    execute format('create policy app_borrar on public.%I for delete to anon, authenticated using (%s)', t, del);
  end loop;
end
$$;


-- ── Quién puede llamar a cada función ──
do $$
declare f text;
begin
  foreach f in array array[
    'app_all_perms()', 'app_sensitive_perms()', 'app_current_nombre()', 'app_effective_perms(text)',
    'app_permissions()', 'app_has_perm(text)', 'app_my_permissions()', 'app_perm_guard()',
    'perm_get_all()', 'perm_set_role(text, text[])', 'perm_set_account(text, jsonb)',
    'acct_create(text, text, text, text, text)', 'acct_update(text, text, text, text, text)',
    'acct_delete(text)', 'set_user_password(text, text)'
  ] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end
$$;
-- app_effective_perms y app_perm_guard no deben llamarse desde afuera (revelan permisos de otros)
revoke execute on function public.app_effective_perms(text) from anon, authenticated;
revoke execute on function public.app_perm_guard() from anon, authenticated;


-- ── Comprobación final: permisos por cargo ──
select role as cargo, array_length(perms, 1) as cantidad_permisos, perms as permisos
from public.dt_role_permissions order by 1;
