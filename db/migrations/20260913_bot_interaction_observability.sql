begin;

-- Incoming bot telemetry contains only a bounded interaction kind and action name.
-- Message text, callback payload tails, Telegram user ids, chat ids and tokens are never
-- persisted. telegram_update_id makes retries idempotent without exposing message content.
create table if not exists bot_interaction_events (
  id                  bigint generated always as identity primary key,
  telegram_update_id  bigint not null unique,
  user_id             bigint references users (id) on delete set null,
  project_id          bigint references projects (id) on delete set null,
  interaction_type    varchar(24) not null,
  action              varchar(100) not null,
  created_at          timestamptz not null default now(),
  constraint bot_interaction_events_update_check check (telegram_update_id >= 0),
  constraint bot_interaction_events_type_check check (
    interaction_type in ('command','reply_button','callback','message','voice','attachment')
  ),
  constraint bot_interaction_events_action_check check (length(btrim(action)) between 1 and 100)
);
create index if not exists bot_interaction_events_created_idx
  on bot_interaction_events (created_at desc, id desc);
create index if not exists bot_interaction_events_user_idx
  on bot_interaction_events (user_id, created_at desc, id desc) where user_id is not null;
create index if not exists bot_interaction_events_project_idx
  on bot_interaction_events (project_id, created_at desc, id desc) where project_id is not null;

commit;
