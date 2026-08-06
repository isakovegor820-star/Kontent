-- Safe operation-wide cancel/reschedule lifecycle. PostgreSQL is authoritative; queue
-- removal is only best effort because every worker claim is fenced by schedule_revision.

begin;

alter table publication_operations
  add column if not exists schedule_revision bigint not null default 1;
alter table publication_operations
  add column if not exists cancelled_at timestamptz;
alter table posts
  add column if not exists provider_started_at timestamptz;
alter table posts
  add column if not exists cancelled_at timestamptz;

alter table publication_operations drop constraint if exists publication_operations_status_check;
alter table publication_operations add constraint publication_operations_status_check check (
  status in (
    'pending', 'partial', 'queued', 'published_unverified', 'published', 'failed', 'cancelled'
  )
);
alter table publication_operations drop constraint if exists publication_operations_schedule_revision_check;
alter table publication_operations add constraint publication_operations_schedule_revision_check
  check (schedule_revision > 0);

alter table posts drop constraint if exists posts_status_check;
alter table posts add constraint posts_status_check check (
  status in (
    'draft', 'scheduled', 'publishing', 'published_unverified', 'published',
    'missing', 'deleted_external', 'failed_retry', 'quarantined', 'cancelled', 'failed'
  )
);

alter table publication_outbox drop constraint if exists publication_outbox_status_check;
alter table publication_outbox add constraint publication_outbox_status_check check (
  status in ('pending', 'dispatching', 'enqueued', 'failed', 'cancelled')
);

create table if not exists publication_operation_events (
  id                    bigint generated always as identity primary key,
  operation_id          bigint not null references publication_operations (id) on delete cascade,
  actor_user_id         bigint not null references users (id) on delete cascade,
  action                text not null check (action in ('cancel', 'reschedule', 'restore_draft')),
  idempotency_key       varchar(128) not null,
  expected_revision     bigint not null check (expected_revision > 0),
  resulting_revision    bigint not null check (resulting_revision > 0),
  from_status           text not null,
  to_status             text not null,
  request_id            varchar(128),
  result                jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  unique (operation_id, idempotency_key)
);
create index if not exists publication_operation_events_operation_idx
  on publication_operation_events (operation_id, created_at desc, id desc);

commit;
