begin;

-- content_brief remains the only source of truth for the per-channel questionnaire.
alter table content_brief add column if not exists formats text[] not null default '{}';
alter table content_brief add column if not exists author_role text not null default '';

-- Replays of an explicit Save return the first durable result and cannot mutate a
-- different payload under the same key.
create table if not exists profile_update_operations (
  id                  bigint generated always as identity primary key,
  user_id             bigint not null references users (id) on delete cascade,
  request_key         varchar(128) not null,
  request_fingerprint varchar(64) not null,
  result_payload      jsonb not null,
  created_at          timestamptz not null default now(),
  unique (user_id, request_key),
  check (length(request_fingerprint) = 64),
  check (jsonb_typeof(result_payload) = 'object')
);

alter table users add column if not exists email_change_generation bigint not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_email_change_generation_check') then
    alter table users add constraint users_email_change_generation_check
      check (email_change_generation >= 0);
  end if;
end $$;

create table if not exists email_change_requests (
  id                  bigint generated always as identity primary key,
  user_id             bigint not null references users (id) on delete cascade,
  request_key         varchar(128) not null,
  request_fingerprint varchar(64) not null,
  target_email        text not null,
  token_hash          varchar(64) not null unique,
  generation          bigint not null check (generation > 0),
  expires_at          timestamptz not null,
  confirmed_at        timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, request_key),
  unique (user_id, generation),
  check (length(request_fingerprint) = 64),
  check (target_email = lower(target_email)),
  check (confirmed_at is null or cancelled_at is null)
);
create index if not exists email_change_requests_user_active_idx
  on email_change_requests (user_id, expires_at desc)
  where confirmed_at is null and cancelled_at is null;

create table if not exists email_change_outbox (
  id                bigint generated always as identity primary key,
  user_id           bigint not null references users (id) on delete cascade,
  request_id        bigint not null unique references email_change_requests (id) on delete cascade,
  generation        bigint not null,
  recipient         text not null,
  token_envelope    text not null,
  status            text not null default 'pending'
                    check (status in ('pending','sending','sent','failed','cancelled')),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  lease_token       text,
  lease_expires_at  timestamptz,
  last_error_code   text,
  sent_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists email_change_outbox_due_idx
  on email_change_outbox (next_attempt_at, id)
  where status in ('pending','failed');

commit;
