begin;

-- Telegram is a project-scoped control surface, so notification choices follow the
-- project rather than the chat. A membership FK removes stale settings when a person
-- leaves a workspace, while digest markers make recurring delivery replay-safe.
create table if not exists bot_notification_preferences (
  project_id                    bigint not null references projects (id) on delete cascade,
  user_id                       bigint not null references users (id) on delete cascade,
  publication_success_enabled  boolean not null default true,
  publication_failure_enabled  boolean not null default true,
  content_opportunities_enabled boolean not null default true,
  daily_digest_enabled         boolean not null default true,
  daily_digest_hour            smallint not null default 9 check (daily_digest_hour between 0 and 23),
  weekly_digest_enabled        boolean not null default true,
  last_daily_digest_date       date,
  last_weekly_digest_date      date,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  primary key (project_id, user_id),
  foreign key (project_id, user_id)
    references project_members (project_id, user_id) on delete cascade
);
create index if not exists bot_notification_preferences_daily_idx
  on bot_notification_preferences (daily_digest_enabled, daily_digest_hour, project_id, user_id);

-- One active conversation per account is enough because a Telegram private chat maps to
-- one Aurora account. The short random token fences stale inline keyboards after a new
-- composer flow starts or the selected project changes.
create table if not exists bot_conversations (
  id          bigint generated always as identity primary key,
  user_id     bigint not null unique references users (id) on delete cascade,
  project_id  bigint not null references projects (id) on delete cascade,
  channel_id  bigint,
  draft_id    bigint,
  state       text not null check (
    state in ('choosing_channel','waiting_text','preview','improving','publishing','completed','cancelled')
  ),
  token       varchar(24) not null check (token ~ '^[A-Za-z0-9_-]{16,24}$'),
  data        jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  expires_at  timestamptz not null default (now() + interval '24 hours'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade,
  foreign key (draft_id, project_id) references drafts (id, project_id) on delete cascade
);
create index if not exists bot_conversations_expiry_idx
  on bot_conversations (expires_at, id);

commit;
