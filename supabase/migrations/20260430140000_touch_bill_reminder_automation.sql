-- Update dashboard row when a bill-reminder webhook alert is delivered

create or replace function public.touch_bill_reminder_automation_after_send(p_trigger_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.user_automations
  set last_run_at = now(),
      updated_at = now()
  where active = true
    and automation_type = 'bill_reminders'
    and coalesce((config->>'bill_trigger_id')::bigint, 0) = p_trigger_id;
$$;

grant execute on function public.touch_bill_reminder_automation_after_send(bigint) to service_role;
