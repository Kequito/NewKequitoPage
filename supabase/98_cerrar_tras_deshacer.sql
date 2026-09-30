-- ══════════════════════════════════════════════════════════════════════
--  REPARAR DESPUÉS DE HABER CORRIDO 99_deshacer.sql
--
--  Orden:  1) correr 03_permisos.sql   (vuelve a cerrar las tablas de datos
--                                       y la función de contraseñas)
--          2) correr ESTE archivo      (cierra dt_session, que el 03 no toca)
--  No borra datos. Se puede correr más de una vez.
-- ══════════════════════════════════════════════════════════════════════

-- dt_session vuelve a quedar sin políticas = nadie la lee ni escribe directo
-- (el login y la gestión de cuentas siguen funcionando por sus funciones).
drop policy if exists abierto_temporal on public.dt_session;
alter table public.dt_session enable row level security;

-- Por si quedó alguna política "abierto_temporal" en otra tabla (no debería, si se corrió el 03)
do $$
declare pol record;
begin
  for pol in select tablename from pg_policies where schemaname = 'public' and policyname = 'abierto_temporal' loop
    execute format('drop policy abierto_temporal on public.%I', pol.tablename);
  end loop;
end
$$;

-- ── Verificación ──
-- Todo debe decir OK. Si alguna fila dice REVISAR, avísale a Claude con una captura.
select 'Tablas abiertas (abierto_temporal)' as chequeo,
       case when count(*) = 0 then 'OK' else 'REVISAR: ' || string_agg(tablename, ', ') end as resultado
from pg_policies where schemaname = 'public' and policyname = 'abierto_temporal'
union all
select 'dt_session cerrada (0 políticas, RLS activo)',
       case when (select count(*) from pg_policies where schemaname = 'public' and tablename = 'dt_session') = 0
             and (select relrowsecurity from pg_class where oid = 'public.dt_session'::regclass)
            then 'OK' else 'REVISAR' end
union all
select 'Tablas de datos con sus 4 políticas',
       case when count(*) = 0 then 'OK' else 'REVISAR: ' || string_agg(t, ', ') end
from (
  select c.relname as t
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'dt\_%'
    and c.relname not in ('dt_session', 'dt_auth_sessions', 'dt_role_permissions')
    and (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) <> 4
) x
union all
select 'Cambiar contraseñas exige permiso',
       case when (select prosrc from pg_proc where proname = 'set_user_password' and pronamespace = 'public'::regnamespace) like '%app_has_perm%'
            then 'OK' else 'REVISAR: corre de nuevo 03_permisos.sql' end;
