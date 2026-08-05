begin;

create table if not exists trend_refresh_operations (
  id               bigint generated always as identity primary key,
  user_id          bigint not null references users (id) on delete cascade,
  idempotency_key  varchar(128) not null,
  fingerprint      varchar(160) not null,
  status           text not null default 'dispatching'
                   check (status in ('dispatching','accepted','failed')),
  queued_count     integer not null default 0 check (queued_count >= 0),
  last_error_code  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create unique index if not exists trend_refresh_operations_active_fingerprint_uniq
  on trend_refresh_operations (user_id, fingerprint) where status = 'dispatching';

commit;
