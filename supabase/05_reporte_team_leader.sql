-- ══════════════════════════════════════════════════════════════════════
--  SCRIPT 05 — REPORTE: los Team Leaders pueden actualizar las 4 fuentes
--
--  ✅ Correr ANTES de publicar la página nueva.
--  ✅ Se puede correr más de una vez sin problema. No borra datos.
--
--  Qué cambia:
--    · "reportes.save" (fuentes 1 a 3 de Reporte) deja de ser un permiso SENSIBLE:
--      ahora funciona también en cuentas SIN contraseña (como los Team Leaders).
--      La fuente 4 ya usaba "leads.save", que los Team Leaders ya tenían.
--    · Se le agrega "reportes.save" al cargo Team Leader (sin tocar sus demás permisos).
--  Las excepciones puntuales por cuenta (🛡 Permisos) se respetan: si a alguien se le
--  bloqueó "reportes.save" a mano, sigue bloqueado.
-- ══════════════════════════════════════════════════════════════════════

-- Sensibles: solo valen en cuentas CON contraseña (igual que antes, sin reportes.save)
create or replace function public.app_sensitive_perms()
returns text[] language sql immutable as $$
  select array['recalls.compare','tl.manage','datalinks.edit',
               'data.upload','accounts.manage','sidebar.manage']::text[]
$$;

-- Team Leader: agregar reportes.save si todavía no lo tiene
update public.dt_role_permissions
   set perms = perms || 'reportes.save'::text,
       updated_at = now(),
       updated_by = 'script 05 (Reporte para Team Leaders)'
 where role = 'team leader'
   and not ('reportes.save' = any(perms));

-- ── Comprobación final: Team Leader debe decir "sí" en las dos columnas ──
select role as cargo,
       case when 'reportes.save' = any(perms) then 'sí' else 'NO' end as puede_actualizar_reporte,
       case when 'leads.save'    = any(perms) then 'sí' else 'NO' end as puede_actualizar_cobertura,
       case when 'reportes.save' = any(public.app_sensitive_perms()) then 'REVISAR: sigue sensible' else 'OK' end as sin_contrasena
from public.dt_role_permissions
order by 1;
