begin;

create table if not exists password_reset_tokens (
  id              bigint generated always as identity primary key,
  user_id         bigint      not null references users (id) on delete cascade,
  token_hash      text        not null unique,
  request_ip_hash text,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now(),
  check (length(token_hash) = 64)
);

create index if not exists password_reset_tokens_user_active_idx
  on password_reset_tokens (user_id, expires_at desc)
  where used_at is null;

commit;
