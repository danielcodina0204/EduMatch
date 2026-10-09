-- Una materia personalizada solo puede eliminarla su creador y únicamente si
-- ningún otro tutor la tiene asignada (evita que el ON DELETE CASCADE de
-- tutor_materias quite la materia a otros tutores). Las solicitudes asociadas
-- la protegen mediante la FK ON DELETE RESTRICT.
drop policy if exists materias_delete_creator on public.materias;
create policy materias_delete_creator on public.materias
for delete to authenticated
using (
  creada_por = auth.uid()
  and not exists (
    select 1 from public.tutor_materias tm
    where tm.materia_id = materias.id
      and tm.tutor_id <> auth.uid()
  )
);

grant delete on public.materias to authenticated;

-- En un UPDATE con WHERE, PostgreSQL exige que la fila resultante también
-- cumpla la política SELECT. Al reasignar una solicitud, el tutor anterior
-- queda en tutores_rechazados y debe poder completar la operación.
drop policy if exists solicitudes_select_partes on public.solicitudes_tutoria;
create policy solicitudes_select_partes on public.solicitudes_tutoria
for select to authenticated using (
  estudiante_id = auth.uid()
  or tutor_id = auth.uid()
  or auth.uid() = any(tutores_rechazados)
);

-- El correo de cada usuario solo es accesible para él mismo a través de su
-- sesión (auth); la API pública de perfiles expone únicamente datos visibles.
revoke select on public.perfiles from anon, authenticated;
grant select (id, nombre, rol, activo, creado_en) on public.perfiles to anon, authenticated;

create or replace function public.eliminar_cuenta_propia()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  rol_actual text;
begin
  if uid is null then
    raise exception 'Usuario no autenticado';
  end if;

  select rol into rol_actual
  from public.perfiles
  where id = uid;

  if rol_actual is distinct from 'Tutor' then
    raise exception 'Solo una cuenta de tutor puede usar esta operación';
  end if;

  if exists (
    select 1
    from public.solicitudes_tutoria
    where tutor_id = uid
      and estado in ('pendiente', 'propuesta_horario', 'aceptada')
  ) then
    raise exception 'No se puede eliminar en este momento: tienes tutorías a tu cargo' using errcode = 'P0001';
  end if;

  -- Materias creadas por el tutor que nadie más usa y sin historial: se eliminan.
  -- Las demás se conservan (creada_por pasa a NULL por la FK).
  delete from public.materias m
  where m.creada_por = uid
    and not exists (select 1 from public.tutor_materias tm where tm.materia_id = m.id and tm.tutor_id <> uid)
    and not exists (select 1 from public.solicitudes_tutoria s where s.materia_id = m.id);

  -- tutor_materias se elimina en cascada; solicitudes y calificaciones
  -- históricas conservan sus datos con tutor_id = NULL.
  delete from public.perfiles where id = uid;
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.eliminar_cuenta_propia() from public;
grant execute on function public.eliminar_cuenta_propia() to authenticated;
