-- ══════════════════════════════════════════════════════════════════════
--  AUDITORÍA DE SEGURIDAD — SOLO LECTURA (no cambia nada)
--  Creado por Claude para revisar la configuración actual antes del paso 4.
--
--  Cómo usarlo:
--    1. Supabase → SQL Editor → New query
--    2. Pegar TODO este archivo → Run
--    3. Exportar el resultado (CSV o copiar) y pasárselo a Claude
--
--  Es UNA sola consulta a propósito: el SQL Editor solo muestra el resultado
--  de la última consulta, así que todo sale junto en una tabla (seccion / objeto / detalle).
--  No muestra contraseñas ni datos de usuarios: solo configuración.
-- ══════════════════════════════════════════════════════════════════════

select seccion, objeto, detalle
from (
  -- 1) ¿Qué tablas/vistas tienen RLS (Row Level Security) activo?
  select 1 as orden, '1. RLS por tabla'::text as seccion, c.relname::text as objeto,
         format('tipo=%s | rls_activo=%s | rls_forzado=%s',
                case c.relkind when 'r' then 'tabla' else 'vista' end,
                c.relrowsecurity, c.relforcerowsecurity) as detalle
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v')

  union all
  -- 2) Políticas RLS existentes
  select 2, '2. Politicas RLS', (tablename || ' / ' || policyname)::text,
         format('operacion=%s | roles=%s | using=%s | with_check=%s', cmd, roles, qual, with_check)
  from pg_policies
  where schemaname = 'public'

  union all
  -- 3) Permisos directos de los roles públicos (anon = cualquiera con la anon key)
  select 3, '3. Permisos anon/authenticated', (table_name::text || ' / ' || grantee::text),
         string_agg(privilege_type::text, ', ' order by privilege_type::text)
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated')
  group by table_name, grantee

  union all
  -- 4) Funciones y si "anon" puede ejecutarlas
  select 4, '4. Funciones', (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')')::text,
         format('security_definer=%s | anon_puede_ejecutar=%s',
                p.prosecdef, has_function_privilege('anon', p.oid, 'EXECUTE'))
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'

  union all
  -- 5) Código de las funciones de login y contraseña (solo el código, no datos)
  select 5, '5. Codigo de funciones', p.proname::text, pg_get_functiondef(p.oid)
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('verify_login', 'set_user_password')

  union all
  -- 6) Definición de la vista pública de usuarios
  select 6, '6. Vista dt_session_public', 'dt_session_public',
         pg_get_viewdef('public.dt_session_public'::regclass, true)

  union all
  -- 7) Columnas de dt_session (solo nombres y tipos)
  select 7, '7. Columnas dt_session', column_name::text, data_type::text
  from information_schema.columns
  where table_schema = 'public' and table_name = 'dt_session'

  union all
  -- 8) Extensiones instaladas (para saber si hay pgcrypto)
  select 8, '8. Extensiones', e.extname::text, (e.extversion || ' | esquema=' || en.nspname)::text
  from pg_extension e
  join pg_namespace en on en.oid = e.extnamespace
) t
order by orden, objeto;
