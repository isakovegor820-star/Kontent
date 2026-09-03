begin;

-- Global administrator controls over an account. A blocked account keeps its data but
-- every live session is rejected; the per-user AI limit overrides the platform default.
alter table users add column if not exists blocked_at timestamptz;
alter table users add column if not exists blocked_reason varchar(500);
alter table users add column if not exists ai_daily_limit integer;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_ai_daily_limit_check') then
    alter table users add constraint users_ai_daily_limit_check
      check (ai_daily_limit is null or (ai_daily_limit between 1 and 100000));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'users_blocked_reason_check') then
    alter table users add constraint users_blocked_reason_check
      check (blocked_reason is null or blocked_at is not null);
  end if;
end $$;

create index if not exists users_blocked_idx on users (blocked_at) where blocked_at is not null;

-- Account-level administrative actions have no project, so they cannot live in
-- audit_events (project_id not null). This journal stores only safe scalar data.
create table if not exists admin_account_actions (
  id bigint generated always as identity primary key,
  actor_user_id bigint references users (id) on delete set null,
  target_user_id bigint not null references users (id) on delete cascade,
  action varchar(64) not null,
  reason varchar(500),
  safe_data jsonb not null default '{}'::jsonb,
  request_id varchar(128),
  created_at timestamptz not null default now(),
  constraint admin_account_actions_action_check check (action in (
    'account.blocked', 'account.unblocked', 'account.sessions_revoked',
    'account.password_reset_sent', 'account.ai_limit_changed'
  )),
  constraint admin_account_actions_request_check
    check (request_id is null or request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  constraint admin_account_actions_safe_data_check check (jsonb_typeof(safe_data) = 'object')
);

create index if not exists admin_account_actions_target_created_idx
  on admin_account_actions (target_user_id, created_at desc, id desc);

commit;
