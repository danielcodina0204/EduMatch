-- Rechazo y reasignación de solicitudes en una sola operación del servidor.
--
-- Por qué existe: en un UPDATE con WHERE, PostgreSQL exige que la fila nueva
-- también cumpla la política SELECT. Al pasar tutor_id de A a B, el tutor A deja
-- de ser parte de la fila y la operación fallaba con 42501. Hacerlo desde el
-- cliente en varias sentencias dependía del orden y de que A figurara en
-- tutores_rechazados. Esta función valida, reasigna y registra el historial de
-- forma atómica y sin ampliar las políticas RLS.

-- 1) Rechazo + reasignación (atómico) -------------------------------------------------
create or replace function public.rechazar_solicitud(p_solicitud_id bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  s public.solicitudes_tutoria%rowtype;
  nombre_anterior text;
  nuevo_id uuid;
  nuevo_nombre text;
  rechazados uuid[];
  momento timestamptz := date_trunc('minute', now());
begin
  if uid is null then
    raise exception 'Usuario no autenticado' using errcode = '42501';
  end if;

  -- Bloqueo de la fila: dos rechazos simultáneos se ejecutan uno tras otro y el
  -- segundo ya no encuentra al tutor como responsable.
  select * into s from public.solicitudes_tutoria where id = p_solicitud_id for update;

  if not found or s.tutor_id is distinct from uid then
    raise exception 'Esta solicitud ya no está asignada a ti.' using errcode = 'EM001';
  end if;

  if s.estado <> 'pendiente' then
    raise exception 'Esta solicitud ya no está pendiente.' using errcode = 'EM002';
  end if;

  rechazados := case
    when uid = any(s.tutores_rechazados) then s.tutores_rechazados
    else array_append(s.tutores_rechazados, uid)
  end;

  select p.nombre into nombre_anterior from public.perfiles p where p.id = uid;

  -- Mismas reglas que tutores_elegibles_reasignacion (rol Tutor, activo, con la
  -- materia, distinto del estudiante, del tutor que rechaza y de los ya
  -- rechazados, sin otra tutoría activa del mismo estudiante y materia).
  select e.id_tutor, p.nombre
    into nuevo_id, nuevo_nombre
  from public.tutores_elegibles_reasignacion(p_solicitud_id) e
  join public.perfiles p on p.id = e.id_tutor
  order by p.creado_en, p.id
  limit 1;

  insert into public.historial_solicitud (solicitud_id, tipo, fecha_evento, detalles)
  values (s.id, 'tutor_rejected', momento,
          jsonb_build_object('tutorId', uid, 'tutorName', nombre_anterior));

  if nuevo_id is not null then
    update public.solicitudes_tutoria
       set tutor_id = nuevo_id,
           tutores_rechazados = rechazados,
           estado = 'pendiente',
           origen_rechazo = null,
           motivo_cancelacion = null,
           abierta_reasignacion = false,
           oculta_para_tutor = false,
           respondida_en = null
     where id = s.id;

    insert into public.historial_solicitud (solicitud_id, tipo, fecha_evento, detalles)
    values (s.id, 'tutor_reassigned', momento,
            jsonb_build_object(
              'tutorId', nuevo_id,
              'tutorName', nuevo_nombre,
              'fromTutorName', nombre_anterior,
              'reason', 'rejected',
              'resultingStatus', 'Pendiente'));

    return jsonb_build_object('reasignada', true, 'tutor_id', nuevo_id,
                              'tutor_nombre', nuevo_nombre, 'estado', 'pendiente');
  end if;

  update public.solicitudes_tutoria
     set tutores_rechazados = rechazados,
         estado = 'cancelada',
         origen_rechazo = null,
         motivo_cancelacion = 'no_tutors',
         abierta_reasignacion = false,
         respondida_en = now()
   where id = s.id;

  insert into public.historial_solicitud (solicitud_id, tipo, fecha_evento, detalles)
  values (s.id, 'no_more_tutors', momento, '{}'::jsonb);

  return jsonb_build_object('reasignada', false, 'tutor_id', null,
                            'tutor_nombre', null, 'estado', 'cancelada');
end;
$$;

-- Supabase concede EXECUTE a anon/authenticated por defecto en funciones nuevas:
-- se retira explícitamente a anon y a PUBLIC.
revoke all on function public.rechazar_solicitud(bigint) from public, anon;
grant execute on function public.rechazar_solicitud(bigint) to authenticated;

-- Las demás funciones security definer solo las usa un usuario con sesión
-- (existe_cuenta se mantiene accesible para anon: se usa antes de iniciar sesión).
revoke all on function public.tutores_elegibles_reasignacion(bigint) from public, anon;
grant execute on function public.tutores_elegibles_reasignacion(bigint) to authenticated;
revoke all on function public.eliminar_cuenta_propia() from public, anon;
grant execute on function public.eliminar_cuenta_propia() to authenticated;

-- Funciones de trigger: no deben poder ejecutarse con una llamada directa. (El permiso
-- EXECUTE de una función de trigger solo se comprueba al crear el trigger.)
revoke all on function public.crear_perfil_desde_auth() from public, anon, authenticated;
revoke all on function public.validar_modificacion_solicitud() from public, anon, authenticated;

-- 2) UPDATE de solicitudes: sin "with check (true)" -----------------------------------
-- La fila resultante debe seguir siendo visible para quien la modifica (estudiante,
-- tutor actual o tutor que acaba de ser reemplazado y quedó en tutores_rechazados).
drop policy if exists solicitudes_update_partes on public.solicitudes_tutoria;
create policy solicitudes_update_partes on public.solicitudes_tutoria
for update to authenticated
using (estudiante_id = auth.uid() or tutor_id = auth.uid())
with check (
  estudiante_id = auth.uid()
  or tutor_id = auth.uid()
  or auth.uid() = any(tutores_rechazados)
);

-- 3) Trigger de validación: un tutor asignado debe ser válido --------------------------
create or replace function public.validar_modificacion_solicitud()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Usuario no autenticado';
  end if;

  if auth.uid() <> old.estudiante_id and (old.tutor_id is null or auth.uid() <> old.tutor_id) then
    raise exception 'No autorizado para modificar esta solicitud';
  end if;

  if new.id <> old.id or new.estudiante_id <> old.estudiante_id or new.materia_id <> old.materia_id then
    raise exception 'No se pueden cambiar el identificador, estudiante o materia de una solicitud';
  end if;

  -- Al cambiar de tutor, el nuevo debe ser un tutor activo con la materia y no el
  -- propio estudiante (evita asignaciones inválidas desde cualquier cliente).
  if new.tutor_id is not null and new.tutor_id is distinct from old.tutor_id then
    if new.tutor_id = new.estudiante_id or not exists (
      select 1
      from public.perfiles p
      join public.tutor_materias tm on tm.tutor_id = p.id and tm.materia_id = new.materia_id
      where p.id = new.tutor_id and p.rol = 'Tutor' and p.activo
    ) then
      raise exception 'El tutor asignado no es válido para esta materia' using errcode = 'EM003';
    end if;
  end if;

  return new;
end;
$$;
