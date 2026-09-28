-- ══════════════════════════════════════════════════════════════════════
--  DESHACER EL BLOQUEO (02_bloqueo.sql) — SOLO PARA EMERGENCIAS
--
--  Úsalo si después de correr 02_bloqueo.sql la página deja de funcionar.
--  Deja todas las tablas ABIERTAS otra vez (como antes del paso 4) para que
--  la página vuelva a funcionar mientras se revisa qué pasó.
--  No borra datos. Las funciones y la tabla de sesiones de 01 se quedan (no molestan).
-- ══════════════════════════════════════════════════════════════════════

do $$
declare
  tablas text[] := array[
    'dt_ops_today', 'dt_ops_today_history', 'dt_leads_campana', 'dt_recalls', 'dt_recalls_alerts',
    'dt_dis', 'dt_ops', 'dt_tl_stats', 'dt_reportes_ventas', 'dt_tl_history',
    'dt_tl_banned', 'dt_recalls_excluded', 'dt_data_links', 'dt_sidebar_config', 'dt_session'
  ];
  t text;
  pol record;
begin
  foreach t in array tablas loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('create policy abierto_temporal on public.%I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end
$$;

-- set_user_password sin chequeo de Supervisor (comportamiento anterior)
drop function if exists public.set_user_password(text, text);
create function public.set_user_password(p_nombre text, p_new_password text default null)
returns void
language plpgsql volatile security definer
set search_path = public, extensions
as $$
begin
  update public.dt_session
     set clave_hash = case when coalesce(p_new_password, '') = '' then null
                           else extensions.crypt(p_new_password, extensions.gen_salt('bf', 8)) end
   where "NOMBRE" = p_nombre;
end
$$;
grant execute on function public.set_user_password(text, text) to anon, authenticated;

select 'Bloqueo deshecho — tablas abiertas otra vez' as resultado;
