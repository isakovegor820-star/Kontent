-- Additive audit/idempotency ledger for every Autopilot scheduling decision.
-- Request/result snapshots intentionally contain only ids, counts, dates and blocker reasons;
-- post drafts are kept in autopilot_plan and are not duplicated in the audit trail.

begin;

create table if not exists autopilot_approval_operations (
  id                bigserial primary key,
  user_id           bigint       not null references users (id) on delete cascade,
  channel_id        bigint       not null references channels (id) on delete cascade,
  plan_id           bigint,
  idempotency_key   varchar(128) not null,
  actor_type        text         not null check (actor_type in ('web', 'bot', 'system')),
  status            text         not null check (status in ('processing', 'completed', 'partial', 'failed')),
  request_snapshot  jsonb        not null default '{}'::jsonb,
  result            jsonb,
  http_status       integer      not null default 200,
  created_at        timestamptz  not null default now(),
  completed_at      timestamptz,
  unique (user_id, idempotency_key)
);

create index if not exists autopilot_approval_operations_plan_idx
  on autopilot_approval_operations (plan_id, created_at desc);

create index if not exists autopilot_approval_operations_channel_idx
  on autopilot_approval_operations (channel_id, created_at desc);

commit;
