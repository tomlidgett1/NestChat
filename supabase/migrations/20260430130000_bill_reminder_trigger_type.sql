-- Allow bill reminder triggers (webhook + AI / keyword evaluation)

alter table public.notification_watch_triggers
  drop constraint if exists notification_watch_triggers_trigger_type_check;

alter table public.notification_watch_triggers
  add constraint notification_watch_triggers_trigger_type_check
    check (trigger_type in (
      'sender', 'subject', 'content', 'label', 'importance', 'custom',
      'new_invite', 'cancellation', 'reschedule', 'calendar_custom',
      'bill_reminder'
    ));
