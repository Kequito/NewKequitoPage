-- ══════════════════════════════════════════════════════════════════════
--  PASO 4 · SCRIPT 2 de 2 — ACTIVAR EL BLOQUEO (RLS por cargo)
--
--  ⚠️ Correr SOLO DESPUÉS de:
--     1) haber corrido 01_sesiones.sql, y
--     2) haber PUBLICADO la versión nueva de la página (la que manda el token).
--     Si se corre antes, la página vieja deja de poder leer/guardar datos.
--     Si algo sale mal: 99_deshacer.sql lo devuelve todo a como estaba.
--  ✅ Se puede correr más de una vez sin problema.
--
--  Qué hace:
--    · Borra TODAS las políticas RLS viejas de las tablas de la app y crea las nuevas.
--    · Leer: cualquier sesión válida (Team Leader o Supervisor).
--    · Escribir: según la tabla — Team Leader+Supervisor, o solo Supervisor.
--    · dt_session: nadie la toca directo; solo por funciones que exigen Supervisor.
--    · set_user_password: pasa a exigir un token de Supervisor.
-- ══════════════════════════════════════════════════════════════════════

do $$
declare
  -- Team Leader o Supervisor pueden escribir (subir Excel, marcar revisados, guardar Leads)
  tablas_editor text[] := array[
    'dt_ops_today', 'dt_ops_today_history', 'dt_leads_campana',
    'dt_recalls', 'dt_recalls_alerts'
  ];
  -- Solo Supervisor puede escribir
  tablas_supervisor text[] := array[
    'dt_dis', 'dt_ops', 'dt_tl_stats', 'dt_reportes_ventas', 'dt_tl_history',
    'dt_tl_banned', 'dt_recalls_excluded', 'dt_data_links', 'dt_sidebar_config'
  ];
  t text;
  pol record;
  quien text;
begin
  foreach t in array tablas_editor || tablas_supervisor || array['dt_session'] loop
    -- 1) limpiar políticas viejas (sean cuales sean)
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    -- 2) RLS activo
    execute format('alter table public.%I enable row level security', t);
  end loop;

  foreach t in array tablas_editor || tablas_supervisor loop
    quien := case when t = any (tablas_editor) then 'public.app_is_editor()' else 'public.app_is_supervisor()' end;

    -- "(select …)" hace que Postgres evalúe el cargo UNA vez por consulta, no una vez por fila
    execute format('create policy app_leer on public.%I for select to anon, authenticated using ((select public.app_is_editor()))', t);
    execute format('create policy app_insertar on public.%I for insert to anon, authenticated with check ((select %s))', t, quien);
    execute format('create policy app_actualizar on public.%I for update to anon, authenticated using ((select %s)) with check ((select %s))', t, quien, quien);
    execute format('create policy app_borrar on public.%I for delete to anon, authenticated using ((select %s))', t, quien);
  end loop;

  -- dt_session: sin políticas = nadie la lee ni la escribe directo (el hash de las
  -- contraseñas deja de ser accesible). El login usa la vista pública + funciones.
end
$$;

-- La vista pública de usuarios (pantalla de login) sigue abierta: solo expone nombre,
-- PEROP1AM, cargo, género y si tiene clave — nunca el hash.
alter view public.dt_session_public set (security_invoker = false);
grant select on public.dt_session_public to anon, authenticated;


-- ── set_user_password: ahora exige un token de Supervisor ──
-- Un Supervisor no puede quedar sin contraseña (no podría volver a entrar como Supervisor).
drop function if exists public.set_user_password(text, text);
create function public.set_user_password(p_nombre text, p_new_password text default null)
returns void
language plpgsql volatile security definer
set search_path = public, extensions
as $$
declare v_cargo text;
begin
  if not public.app_is_supervisor() then
    raise exception 'Solo un Supervisor puede cambiar contraseñas' using errcode = '42501';
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

  -- Cambiar la contraseña cierra las sesiones abiertas de esa cuenta
  delete from public.dt_auth_sessions where nombre = p_nombre;
end
$$;
revoke all on function public.set_user_password(text, text) from public;
grant execute on function public.set_user_password(text, text) to anon, authenticated;


-- ── Comprobación final: cada tabla debe mostrar rls_activo = true y 4 políticas
--    (dt_session: 0 políticas a propósito) ──
select c.relname as tabla, c.relrowsecurity as rls_activo,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as politicas
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'dt\_%'
order by 1;
