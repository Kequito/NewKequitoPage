-- ══════════════════════════════════════════════════════════════════════
--  PASO 6 · SCRIPT 04 — REPORTE: datos extra (Avg Price "Check" y T.Wait)
--
--  ✅ Correr ANTES de publicar la página nueva de Reporte (si no, guardar el
--     Avg Price o el Wait da error; lo demás sigue funcionando).
--  ✅ Solo AGREGA una tabla; se puede correr más de una vez sin problema.
--
--  Qué crea:
--    · dt_reportes_extra → cada vez que se pega el "Check" (Avg Price) o el
--      Wait en Reporte se guarda una fila nueva (queda el historial completo).
--        section    = 'check' | 'wait'
--        by_country = [{country, ...}]   global = totales
--    · La cobertura operativa (sección 4) NO usa esta tabla: se guarda en
--      dt_leads_campana, la misma de "Leads por Campaña".
--
--  Permisos: leer = cualquier sesión válida; guardar = permiso "reportes.save"
--  (igual que el snapshot de Approve).
-- ══════════════════════════════════════════════════════════════════════

create table if not exists public.dt_reportes_extra (
  id         bigint generated always as identity primary key,
  section    text        not null check (section in ('check', 'wait')),
  by_country jsonb       not null default '[]'::jsonb,
  global     jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  created_by text
);
create index if not exists dt_reportes_extra_section_idx
  on public.dt_reportes_extra (section, created_at desc);

grant select, insert, update, delete on public.dt_reportes_extra to anon, authenticated;

do $$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'dt_reportes_extra' loop
    execute format('drop policy %I on public.dt_reportes_extra', pol.policyname);
  end loop;
end
$$;

alter table public.dt_reportes_extra enable row level security;

create policy app_leer      on public.dt_reportes_extra for select to anon, authenticated
  using ((select public.app_role()) is not null);
create policy app_insertar  on public.dt_reportes_extra for insert to anon, authenticated
  with check ((select public.app_has_perm('reportes.save')));
create policy app_actualizar on public.dt_reportes_extra for update to anon, authenticated
  using ((select public.app_has_perm('reportes.save'))) with check ((select public.app_has_perm('reportes.save')));
create policy app_borrar    on public.dt_reportes_extra for delete to anon, authenticated
  using ((select public.app_has_perm('reportes.save')));

-- ── Comprobación final: debe mostrar rls_activo = true y 4 políticas ──
select c.relname as tabla, c.relrowsecurity as rls_activo,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as politicas
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'dt_reportes_extra';
