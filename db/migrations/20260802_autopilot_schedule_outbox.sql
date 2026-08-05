begin;

-- A plan lease makes `approving` reclaimable after a process crash. The operation id is
-- also a fencing token: a resumed stale process cannot checkpoint or finalize a plan that
-- a newer confirmation already reclaimed.
alter table autopilot_plan add column if not exists approval_operation_id bigint
  references autopilot_approval_operations (id) on delete set null;
alter table autopilot_plan add column if not exists approval_started_at timestamptz;
alter table autopilot_plan add column if not exists approval_heartbeat_at timestamptz;

-- One immutable scheduling outcome per plan item. The posts row, this checkpoint and the
-- item.postId mutation are committed together; BullMQ delivery happens afterwards and may
-- be repeated with deterministic `post-{post_id}` identity.
create table if not exists autopilot_schedule_outbox (
  id            bigint generated always as identity primary key,
  plan_id       bigint      not null references autopilot_plan (id) on delete cascade,
  item_index    integer     not null check (item_index >= 0),
  user_id       bigint      not null references users (id) on delete cascade,
  channel_id    bigint      not null references channels (id) on delete cascade,
  operation_id  bigint      references autopilot_approval_operations (id) on delete set null,
  post_id       bigint      not null unique references posts (id) on delete cascade,
  scheduled_at  timestamptz not null,
  status        text        not null default 'pending'
                             check (status in ('pending', 'enqueued', 'cancelled')),
  attempts      integer     not null default 0 check (attempts >= 0),
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  enqueued_at   timestamptz,
  unique (plan_id, item_index)
);

create index if not exists autopilot_schedule_outbox_pending_idx
  on autopilot_schedule_outbox (updated_at, id) where status = 'pending';
create index if not exists autopilot_schedule_outbox_operation_idx
  on autopilot_schedule_outbox (operation_id, id);

commit;
