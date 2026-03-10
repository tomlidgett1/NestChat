create or replace function public.set_user_name_atomic(
  p_handle text,
  p_name text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $set_user_name$
declare
  v_now bigint := extract(epoch from now())::bigint;
  v_existing_name text;
begin
  insert into public.user_profiles (handle, name, facts, first_seen, last_seen)
  values (p_handle, null, '[]'::jsonb, v_now, v_now)
  on conflict (handle) do nothing;

  select name
    into v_existing_name
  from public.user_profiles
  where handle = p_handle
  for update;

  if v_existing_name = p_name then
    update public.user_profiles
      set last_seen = v_now
      where handle = p_handle;
    return false;
  end if;

  update public.user_profiles
    set name = p_name,
        last_seen = v_now
    where handle = p_handle;

  return true;
end;
$set_user_name$;
