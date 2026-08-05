-- One Composer action is one immutable revision across every destination.
begin;

create table if not exists publication_operations (
  id               bigint generated always as identity primary key,
  user_id          bigint not null references users (id) on delete cascade,
  draft_id         bigint references drafts (id) on delete set null,
  draft_version    bigint not null check (draft_version > 0),
  idempotency_key  varchar(128) not null,
  fingerprint      varchar(64) not null,
  text             text not null,
  media            jsonb,
  scheduled_at     timestamptz not null,
  timezone         varchar(80) not null default 'UTC',
  destination_ids  jsonb not null,
  options           jsonb not null default '{}'::jsonb,
  status            text not null default 'pending'
                    check (status in ('pending','partial','queued','published','failed')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create unique index if not exists publication_operations_draft_revision_uniq
  on publication_operations (user_id, draft_id, draft_version)
  where draft_id is not null;
create unique index if not exists publication_operations_fingerprint_uniq
  on publication_operations (user_id, fingerprint);

alter table posts add column if not exists publication_operation_id bigint
  references publication_operations (id) on delete set null;
alter table posts add column if not exists publication_draft_version bigint;
create unique index if not exists posts_publication_operation_destination_uniq
  on posts (publication_operation_id, channel_id)
  where publication_operation_id is not null;

create table if not exists publication_outbox (
  id               bigint generated always as identity primary key,
  operation_id     bigint not null references publication_operations (id) on delete cascade,
  post_id           bigint not null references posts (id) on delete cascade,
  status            text not null default 'pending'
                    check (status in ('pending','dispatching','enqueued','failed')),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  last_error_code   text,
  lease_token       text,
  lease_expires_at  timestamptz,
  enqueued_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (post_id)
);
create index if not exists publication_outbox_due_idx
  on publication_outbox (next_attempt_at, id)
  where status in ('pending','failed');

commit;
