-- Supabase Auth responde "invalid_credentials" tanto si la cuenta no existe
-- como si la contraseña es incorrecta. Esta función permite al cliente
-- distinguir ambos casos tras un intento fallido, sin exponer auth.users.
create or replace function public.existe_cuenta(p_correo text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from auth.users u
    where lower(u.email) = lower(trim(p_correo))
      and u.deleted_at is null
  );
$$;

revoke all on function public.existe_cuenta(text) from public;
grant execute on function public.existe_cuenta(text) to anon, authenticated;

-- Tutores que pueden recibir una solicitud reasignada. Se calcula en el
-- servidor porque, por RLS, el tutor que rechaza no puede ver las demás
-- solicitudes del estudiante (necesarias para no duplicar tutorías activas).
create or replace function public.tutores_elegibles_reasignacion(p_solicitud_id bigint)
returns table (id_tutor uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s public.solicitudes_tutoria%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Usuario no autenticado' using errcode = '42501';
  end if;

  select * into s from public.solicitudes_tutoria where id = p_solicitud_id;
  if not found then
    return;
  end if;

  if auth.uid() <> s.estudiante_id and auth.uid() is distinct from s.tutor_id then
    raise exception 'No autorizado para consultar esta solicitud' using errcode = '42501';
  end if;

  return query
    select p.id
    from public.perfiles p
    join public.tutor_materias tm on tm.tutor_id = p.id and tm.materia_id = s.materia_id
    where p.rol = 'Tutor'
      and p.activo
      and p.id <> s.estudiante_id
      and p.id is distinct from s.tutor_id
      and not coalesce(p.id = any(s.tutores_rechazados), false)
      and not exists (
        select 1
        from public.solicitudes_tutoria o
        where o.id <> s.id
          and o.estudiante_id = s.estudiante_id
          and o.materia_id = s.materia_id
          and o.tutor_id = p.id
          and o.estado in ('pendiente', 'propuesta_horario', 'aceptada')
      )
    order by p.creado_en, p.id;
end;
$$;

revoke all on function public.tutores_elegibles_reasignacion(bigint) from public;
grant execute on function public.tutores_elegibles_reasignacion(bigint) to authenticated;
