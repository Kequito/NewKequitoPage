-- ══════════════════════════════════════════════════════════════════════
--  SCRIPT 07 — PERMISO DE LA SECCIÓN NUEVA "VENTAS POR FUERA"
--
--  ✅ Correr ANTES de publicar la página nueva. Es compatible con la página actual
--     (solo agrega un permiso que la página vieja no usa).
--  ✅ Se puede correr más de una vez sin problema. No borra datos.
--
--  Qué hace:
--    · Agrega "view.ventasfuera" al catálogo de permisos (app_all_perms).
--    · Se lo da a los cargos Supervisor y Team Leader. Operador NO lo recibe
--      (se le puede dar desde Gestión de Cuentas → Permisos por cargo, si hace falta).
--  No crea tablas: la sección lee las hojas de Google en vivo, y sus links se guardan en
--  dt_data_links (la misma tabla de siempre de Actualización de Data).
-- ══════════════════════════════════════════════════════════════════════

-- Catálogo (debe coincidir con PERM_CATALOG en js/core/permissions.js)
create or replace function public.app_all_perms()
returns text[] language sql immutable as $$
  select array[
    'view.dashboard','view.goodday','view.ops','view.opstoday','view.opslive',
    'view.reportes','view.recalls','view.leads','view.ventasfuera','view.tl',
    'opstoday.upload','recalls.upload','recalls.review','recalls.compare','leads.save',
    'reportes.save','tl.manage','datalinks.edit','data.upload','accounts.manage','sidebar.manage'
  ]::text[]
$$;

-- Supervisor y Team Leader: agregar el permiso si todavía no lo tienen
update public.dt_role_permissions
   set perms = perms || 'view.ventasfuera'::text,
       updated_at = now(),
       updated_by = 'script 07 (Ventas por Fuera)'
 where role in ('supervisor', 'team leader')
   and not ('view.ventasfuera' = any(perms));

-- ── Comprobación final: Supervisor y Team Leader deben decir "sí" ──
select role as cargo,
       case when 'view.ventasfuera' = any(perms) then 'sí' else 'no' end as ve_ventas_por_fuera,
       case when 'view.ventasfuera' = any(public.app_all_perms()) then 'OK' else 'REVISAR' end as catalogo
from public.dt_role_permissions
order by 1;
