begin;

-- Account-facing preferences are intentionally separate from the per-channel content
-- brief. This prevents profile edits (name, phone, locale or theme) from rewriting the
-- prompt configuration of a selected publishing channel.
create table if not exists user_account_settings (
  user_id                         bigint primary key references users (id) on delete cascade,
  first_name                      varchar(80) not null default '',
  last_name                       varchar(80) not null default '',
  display_name                    varchar(120) not null default '',
  job_title                       varchar(160) not null default '',
  bio                             varchar(1000) not null default '',
  phone                           varchar(32),
  phone_verified_at               timestamptz,
  pending_phone                   varchar(32),
  phone_verification_hash         varchar(160),
  phone_verification_expires_at   timestamptz,
  phone_verification_attempts     smallint not null default 0,
  locale                          varchar(12) not null default 'ru',
  timezone                        varchar(80) not null default 'Europe/Moscow',
  theme                           varchar(12) not null default 'system',
  notification_preferences        jsonb not null default '{
    "publication_ready":{"inApp":true,"email":true,"telegram":true},
    "publication_result":{"inApp":true,"email":true,"telegram":true},
    "autopilot_plan":{"inApp":true,"email":false,"telegram":true},
    "limit_warning":{"inApp":true,"email":true,"telegram":false},
    "integration_problem":{"inApp":true,"email":true,"telegram":true},
    "security":{"inApp":true,"email":true,"telegram":false}
  }'::jsonb,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  constraint user_account_settings_names_check check (
    length(first_name) <= 80 and length(last_name) <= 80
    and length(display_name) <= 120 and length(job_title) <= 160
    and length(bio) <= 1000
  ),
  constraint user_account_settings_phone_check check (
    phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'
  ),
  constraint user_account_settings_pending_phone_check check (
    pending_phone is null or pending_phone ~ '^\+[1-9][0-9]{7,14}$'
  ),
  constraint user_account_settings_phone_challenge_check check (
    (pending_phone is null and phone_verification_hash is null and phone_verification_expires_at is null)
    or (pending_phone is not null and phone_verification_hash is not null and phone_verification_expires_at is not null)
  ),
  constraint user_account_settings_phone_attempts_check check (
    phone_verification_attempts between 0 and 5
  ),
  constraint user_account_settings_locale_check check (locale in ('ru', 'en')),
  constraint user_account_settings_timezone_check check (length(timezone) between 1 and 80),
  constraint user_account_settings_theme_check check (theme in ('light', 'dark', 'system')),
  constraint user_account_settings_notifications_check check (
    jsonb_typeof(notification_preferences) = 'object'
  )
);

-- Preview runs use their own product quota. They never create ai_usage rows and therefore
-- cannot reduce the normal daily generation allowance. Failed provider calls still count:
-- otherwise a broken or adversarial client could retry paid requests without a bound.
create table if not exists settings_preview_runs (
  id                bigint generated always as identity primary key,
  user_id           bigint not null references users (id) on delete cascade,
  project_id        bigint not null references projects (id) on delete cascade,
  channel_id        bigint not null,
  usage_date        date not null default current_date,
  topic             varchar(500) not null,
  status            varchar(16) not null default 'running',
  result_text       text,
  applied_settings  jsonb not null default '[]'::jsonb,
  error_code        varchar(80),
  created_at        timestamptz not null default now(),
  completed_at      timestamptz,
  constraint settings_preview_runs_channel_project_fk
    foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade,
  constraint settings_preview_runs_status_check
    check (status in ('running', 'succeeded', 'failed')),
  constraint settings_preview_runs_topic_check
    check (length(btrim(topic)) between 3 and 500),
  constraint settings_preview_runs_applied_check
    check (jsonb_typeof(applied_settings) = 'array')
);

create index if not exists settings_preview_runs_daily_idx
  on settings_preview_runs (user_id, usage_date, id desc);

commit;
