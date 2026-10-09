-- Diagnóstico de solo lectura para el SQL Editor de Supabase (no modifica nada).
-- Ejecuta cada bloque y compara con el resultado esperado indicado.

-- 1) RLS activo en las 6 tablas -> relrowsecurity = true en todas.
select c.relname, c.relrowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('perfiles','materias','tutor_materias','solicitudes_tutoria','historial_solicitud','calificaciones')
order by 1;

-- 2) Políticas de solicitudes e historial.
--    Esperado: solicitudes_select_partes -> qual incluye "tutores_rechazados".
--              solicitudes_update_partes -> with_check incluye "tutores_rechazados" (NO "true").
--              historial_select_partes / historial_insert_partes presentes.
select tablename, policyname, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and tablename in ('solicitudes_tutoria','historial_solicitud')
order by tablename, policyname;

-- 3) Triggers de solicitudes -> 2 filas (solicitudes_tutoria_actualizada_en y
--    validar_modificacion_solicitud_edumatch), ambas con tgenabled = 'O'.
select tgname, tgenabled
from pg_trigger
where tgrelid = 'public.solicitudes_tutoria'::regclass and not tgisinternal
order by 1;

-- 4) Funciones: existen, security definer con search_path fijo y permisos.
--    Esperado: las funciones security definer con proconfig {search_path=...};
--              anon_puede_ejecutar = false en todas salvo existe_cuenta (true);
--              authenticated_puede_ejecutar = true solo en rechazar_solicitud,
--              tutores_elegibles_reasignacion, eliminar_cuenta_propia y existe_cuenta.
select p.proname,
       pg_get_function_identity_arguments(p.oid) as argumentos,
       p.prosecdef as security_definer,
       p.proconfig,
       has_function_privilege('anon', p.oid, 'execute')          as anon_puede_ejecutar,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_puede_ejecutar
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and p.proname in ('rechazar_solicitud','tutores_elegibles_reasignacion','existe_cuenta',
                    'eliminar_cuenta_propia','crear_perfil_desde_auth','validar_modificacion_solicitud')
order by 1;
-- Si falta "rechazar_solicitud": falta aplicar 20261004010000_reasignacion_atomica.sql.

-- 5) existe_cuenta (cambia el correo) -> true si existe y no está eliminada, false si no.
select public.existe_cuenta('correo-que-existe@ejemplo.com') as existe,
       public.existe_cuenta('correo-inexistente@ejemplo.com') as no_existe;

-- 6) El correo no es legible por la API pública -> false.
select has_column_privilege('authenticated', 'public.perfiles', 'correo', 'select') as correo_legible;

-- 7) Simulación como un tutor real (sustituye los UUID). Se ejecuta en UNA transacción
--    y termina en ROLLBACK, por lo que no deja cambios.
--    begin;
--      set local role authenticated;
--      select set_config('request.jwt.claim.sub', '<UUID_DEL_TUTOR_QUE_RECHAZA>', true);
--      select * from public.tutores_elegibles_reasignacion(<ID_SOLICITUD>);   -- tutores candidatos
--      select public.rechazar_solicitud(<ID_SOLICITUD>);                      -- rechaza y reasigna
--      select id, tutor_id, estado, tutores_rechazados from public.solicitudes_tutoria where id = <ID_SOLICITUD>;
--    rollback;

-- 8) Opcional: migraciones registradas (solo si usas Supabase CLI; el SQL Editor no las registra).
-- select version from supabase_migrations.schema_migrations order by 1;
