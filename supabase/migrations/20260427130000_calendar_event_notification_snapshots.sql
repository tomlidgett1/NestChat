-- Stores last "meaningful" calendar fields per subscription + event so webhook alerts
-- only fire when start, end, location, or status changes (not RSVP/attendee-only updates).

create table if not exists public.calendar_event_notification_snapshots (
  subscription_id uuid not null references public.notification_webhook_subscriptions (id) on delete cascade,
  google_event_id text not null,
  fingerprint text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (subscription_id, google_event_id)
);

create index if not exists calendar_event_notification_snapshots_sub_updated_idx
  on public.calendar_event_notification_snapshots (subscription_id, updated_at desc);

comment on table public.calendar_event_notification_snapshots is
  'Last notified fingerprint (start/end/location/status) per calendar event; suppresses alerts on attendee-only updates.';
