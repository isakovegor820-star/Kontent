begin;

-- Platform administrators can pause only the Telegram control surface without
-- archiving accounts, projects or their content. Keeping this state separate from
-- product membership makes the action reversible and auditable.
create table if not exists bot_user_controls (
  user_id             bigint primary key references users (id) on delete cascade,
  enabled             boolean not null default true,
  disabled_reason     varchar(500),
  updated_by_user_id  bigint references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint bot_user_controls_reason_check check (
    (enabled = true and disabled_reason is null)
    or (enabled = false and length(btrim(disabled_reason)) between 3 and 500)
  )
);

create table if not exists bot_project_controls (
  project_id          bigint primary key references projects (id) on delete cascade,
  enabled             boolean not null default true,
  disabled_reason     varchar(500),
  updated_by_user_id  bigint references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint bot_project_controls_reason_check check (
    (enabled = true and disabled_reason is null)
    or (enabled = false and length(btrim(disabled_reason)) between 3 and 500)
  )
);

-- Delivery telemetry contains only routing identifiers and a bounded provider error.
-- Message bodies and Telegram tokens are intentionally never persisted here.
create table if not exists bot_delivery_events (
  id                   bigint generated always as identity primary key,
  user_id              bigint references users (id) on delete set null,
  project_id           bigint references projects (id) on delete set null,
  chat_id              bigint,
  method               varchar(64) not null,
  source               varchar(80) not null default 'assistant',
  ok                   boolean not null,
  telegram_error_code  integer,
  error_code           varchar(100),
  error_description    varchar(500),
  created_at           timestamptz not null default now(),
  constraint bot_delivery_events_method_check check (length(btrim(method)) between 1 and 64),
  constraint bot_delivery_events_source_check check (length(btrim(source)) between 1 and 80),
  constraint bot_delivery_events_error_check check (
    (ok = true and error_code is null and error_description is null)
    or ok = false
  )
);
create index if not exists bot_delivery_events_created_idx
  on bot_delivery_events (created_at desc, id desc);
create index if not exists bot_delivery_events_failure_idx
  on bot_delivery_events (created_at desc, id desc) where ok = false;
create index if not exists bot_delivery_events_user_idx
  on bot_delivery_events (user_id, created_at desc, id desc) where user_id is not null;

create table if not exists bot_admin_action_events (
  id             bigint generated always as identity primary key,
  actor_user_id  bigint references users (id) on delete set null,
  action         varchar(100) not null,
  target_type    varchar(40) not null,
  target_id      bigint,
  safe_data      jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint bot_admin_action_events_action_check check (length(btrim(action)) between 1 and 100),
  constraint bot_admin_action_events_target_check check (target_type in ('user','project','runtime')),
  constraint bot_admin_action_events_target_id_check check (
    (target_type = 'runtime' and target_id is null)
    or (target_type in ('user','project') and target_id > 0)
  ),
  constraint bot_admin_action_events_safe_data_check check (jsonb_typeof(safe_data) = 'object')
);
create index if not exists bot_admin_action_events_created_idx
  on bot_admin_action_events (created_at desc, id desc);

commit;
