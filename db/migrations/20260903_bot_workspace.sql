begin;

alter table bot_conversations drop constraint if exists bot_conversations_state_check;
alter table bot_conversations add constraint bot_conversations_state_check check (
  state in (
    'choosing_channel','waiting_text','preview','improving','publishing',
    'review_changes','completed','cancelled'
  )
);

alter table bot_notification_preferences
  add column if not exists post_results_enabled boolean not null default true,
  add column if not exists review_reminders_enabled boolean not null default true,
  add column if not exists problem_digest_enabled boolean not null default true;

create table if not exists bot_post_result_notifications (
  post_id       bigint not null references posts (id) on delete cascade,
  project_id    bigint not null references projects (id) on delete cascade,
  user_id       bigint not null references users (id) on delete cascade,
  window_hours  smallint not null default 24 check (window_hours between 24 and 168),
  delivered_at  timestamptz,
  created_at    timestamptz not null default now(),
  primary key (post_id, user_id, window_hours),
  foreign key (project_id, user_id)
    references project_members (project_id, user_id) on delete cascade
);
create index if not exists bot_post_result_notifications_pending_idx
  on bot_post_result_notifications (created_at, post_id)
  where delivered_at is null;

-- Telegram Business client conversations are intentionally disabled by default.
-- Even after activation, every suggested answer remains pending until a human approves it.
create table if not exists bot_client_assistant_preferences (
  project_id        bigint primary key references projects (id) on delete cascade,
  business_connection_id text unique,
  enabled           boolean not null default false,
  require_approval  boolean not null default true check (require_approval = true),
  welcome_text      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint bot_client_assistant_welcome_check
    check (welcome_text is null or length(btrim(welcome_text)) between 1 and 1200)
);

create table if not exists bot_client_inquiries (
  id                              bigint generated always as identity primary key,
  project_id                      bigint not null references projects (id) on delete cascade,
  business_connection_id          text not null,
  external_chat_id                bigint not null,
  external_message_id             bigint not null,
  sender_external_id              bigint,
  incoming_text                   text not null,
  suggested_reply                 text,
  status                          text not null default 'pending',
  resolved_by_user_id             bigint references users (id) on delete set null,
  resolved_at                     timestamptz,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  constraint bot_client_inquiries_text_check check (length(btrim(incoming_text)) between 1 and 8000),
  constraint bot_client_inquiries_reply_check check (suggested_reply is null or length(btrim(suggested_reply)) between 1 and 8000),
  constraint bot_client_inquiries_status_check
    check (status in ('pending','reply_ready','approved','sent','dismissed','failed')),
  unique (business_connection_id, external_chat_id, external_message_id)
);
create index if not exists bot_client_inquiries_project_status_idx
  on bot_client_inquiries (project_id, status, created_at, id);

commit;
