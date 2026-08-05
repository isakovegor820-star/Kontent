begin;

alter table autopilot_plan add column if not exists revision bigint not null default 1;
alter table autopilot_plan drop constraint if exists autopilot_plan_revision_check;
alter table autopilot_plan add constraint autopilot_plan_revision_check check (revision > 0);

alter table autopilot_approval_operations add column if not exists plan_revision bigint;
alter table autopilot_approval_operations add column if not exists preview_hash char(64);

create table if not exists autopilot_approval_previews (
  token_hash     char(64) primary key,
  user_id        bigint not null references users (id) on delete cascade,
  channel_id     bigint not null references channels (id) on delete cascade,
  plan_id        bigint not null references autopilot_plan (id) on delete cascade,
  plan_revision  bigint not null check (plan_revision > 0),
  preview_hash   char(64) not null,
  snapshot       jsonb not null,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  operation_id   bigint references autopilot_approval_operations (id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists autopilot_approval_previews_expiry_idx
  on autopilot_approval_previews (expires_at, token_hash)
  where consumed_at is null;
create index if not exists autopilot_approval_previews_plan_idx
  on autopilot_approval_previews (plan_id, plan_revision, created_at desc);

commit;

