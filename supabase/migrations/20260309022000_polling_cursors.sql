create table if not exists polling_cursors (
  id text primary key,
  last_value text not null,
  updated_at timestamptz not null default now()
);

alter table polling_cursors enable row level security;
