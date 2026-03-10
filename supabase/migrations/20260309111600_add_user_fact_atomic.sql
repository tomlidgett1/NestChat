create or replace function public.add_user_fact_atomic(
  p_handle text,
  p_fact text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $add_user_fact$
declare
  v_now bigint := extract(epoch from now())::bigint;
  v_existing jsonb := '[]'::jsonb;
begin
  insert into public.user_profiles (handle, name, facts, first_seen, last_seen)
  values (p_handle, null, '[]'::jsonb, v_now, v_now)
  on conflict (handle) do nothing;

  select facts
    into v_existing
  from public.user_profiles
  where handle = p_handle
  for update;

  if exists (
    select 1
    from jsonb_array_elements_text(coalesce(v_existing, '[]'::jsonb)) as fact(value)
    where fact.value = p_fact
  ) then
    update public.user_profiles
      set last_seen = v_now
      where handle = p_handle;
    return false;
  end if;

  update public.user_profiles
    set facts = coalesce(v_existing, '[]'::jsonb) || to_jsonb(array[p_fact]::text[]),
        last_seen = v_now
    where handle = p_handle;

  return true;
end;
$add_user_fact$;
