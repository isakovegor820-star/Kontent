begin;

-- A Telegram user can start account linking from the private bot chat. Only a SHA-256
-- token digest is stored; the raw single-use token remains in the URL fragment and is
-- never sent in an HTTP request URL or written to application logs.
create table if not exists bot_connection_sessions (
  token_hash             char(64) primary key,
  telegram_user_id       bigint not null,
  telegram_chat_id       bigint not null,
  telegram_username      varchar(64),
  telegram_display_name  varchar(200) not null,
  confirmed_user_id      bigint references users (id) on delete cascade,
  used_at                timestamptz,
  revoked_at             timestamptz,
  expires_at             timestamptz not null,
  created_at             timestamptz not null default now(),
  constraint bot_connection_sessions_token_check check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint bot_connection_sessions_identity_check check (
    telegram_user_id > 0 and telegram_chat_id > 0
  ),
  constraint bot_connection_sessions_lifecycle_check check (
    ((used_at is null and confirmed_user_id is null) or
     (used_at is not null and confirmed_user_id is not null))
    and not (used_at is not null and revoked_at is not null)
  ),
  constraint bot_connection_sessions_expiry_check check (expires_at > created_at)
);
create unique index if not exists bot_connection_sessions_active_chat_idx
  on bot_connection_sessions (telegram_chat_id)
  where used_at is null and revoked_at is null;
create index if not exists bot_connection_sessions_expiry_idx
  on bot_connection_sessions (expires_at, created_at);
create index if not exists bot_connection_sessions_confirmed_user_idx
  on bot_connection_sessions (confirmed_user_id, used_at desc)
  where confirmed_user_id is not null;

commit;
