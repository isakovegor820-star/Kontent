begin;

-- Build lifecycle remains separate from approval lifecycle. A partial row is a resumable
-- attempt; pending/approving/approved continue to mean a user-visible publication plan.
alter table autopilot_plan drop constraint if exists autopilot_plan_status_check;
alter table autopilot_plan
  add constraint autopilot_plan_status_check
  check (status in ('building', 'partial', 'pending', 'approving', 'approved', 'done', 'error'));

alter table autopilot_plan
  add column if not exists build_report jsonb not null default '{}'::jsonb,
  add column if not exists repair_strategy text,
  add column if not exists terminal_outcome text,
  add column if not exists repair_attempt integer not null default 0,
  add column if not exists last_repair_job_id uuid,
  add column if not exists ai_call_count integer not null default 0;

alter table autopilot_plan add constraint autopilot_plan_build_report_check
  check (jsonb_typeof(build_report) = 'object');
alter table autopilot_plan add constraint autopilot_plan_repair_strategy_check
  check (repair_strategy is null or repair_strategy in (
    'deterministic_format', 'rewrite', 'add_knowledge', 'human_review',
    'provider_retry', 'settings_change'
  ));
alter table autopilot_plan add constraint autopilot_plan_terminal_outcome_check
  check (terminal_outcome is null or terminal_outcome in (
    'complete', 'partial', 'cancelled', 'quota', 'provider_error', 'source_error',
    'semantic_block', 'editorial_block', 'duplicate', 'manual_wait'
  ));
alter table autopilot_plan add constraint autopilot_plan_repair_attempt_check
  check (repair_attempt between 0 and 100);
alter table autopilot_plan add constraint autopilot_plan_ai_call_count_check
  check (ai_call_count >= 0);

create table if not exists autopilot_repair_operations (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  user_id            bigint not null references users (id) on delete cascade,
  channel_id         bigint not null references channels (id) on delete cascade,
  source_plan_id     bigint not null,
  plan_id            bigint references autopilot_plan (id) on delete set null,
  job_id              uuid not null,
  request_hash        varchar(64) not null,
  base_revision       bigint not null,
  item_indexes        jsonb not null default '[]'::jsonb,
  repair_strategy     text,
  attempt_number      integer not null,
  status              text not null default 'queued',
  ai_call_count       integer not null default 0,
  terminal_outcome    text,
  diagnostic          jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz,
  constraint autopilot_repair_operations_job_uniq unique (project_id, job_id),
  constraint autopilot_repair_operations_request_hash_check check (request_hash ~ '^[a-f0-9]{64}$'),
  constraint autopilot_repair_operations_source_plan_check check (source_plan_id > 0),
  constraint autopilot_repair_operations_revision_check check (base_revision > 0),
  constraint autopilot_repair_operations_indexes_check check (jsonb_typeof(item_indexes) = 'array'),
  constraint autopilot_repair_operations_strategy_check check (
    repair_strategy is null or repair_strategy in (
      'deterministic_format', 'rewrite', 'add_knowledge', 'human_review',
      'provider_retry', 'settings_change'
    )
  ),
  constraint autopilot_repair_operations_attempt_check check (attempt_number between 1 and 100),
  constraint autopilot_repair_operations_status_check check (
    status in ('queued', 'processing', 'completed', 'partial', 'failed')
  ),
  constraint autopilot_repair_operations_ai_calls_check check (ai_call_count >= 0),
  constraint autopilot_repair_operations_diagnostic_check check (jsonb_typeof(diagnostic) = 'object')
);

create unique index if not exists autopilot_repair_operations_active_plan_uniq
  on autopilot_repair_operations (plan_id)
  where plan_id is not null and status in ('queued', 'processing');
create index if not exists autopilot_repair_operations_scope_idx
  on autopilot_repair_operations (project_id, channel_id, created_at desc, id desc);

-- Defaults affect only channels created after this migration. Existing user settings are
-- deliberately left untouched.
alter table autopilot_settings alter column post_frequency set default 5;
alter table autopilot_settings alter column quick_settings set default
  '{"newsPerWeek":2,"detail":2,"energy":2,"emoji":1}'::jsonb;
alter table autopilot_plan alter column quick_settings set default
  '{"newsPerWeek":2,"detail":2,"energy":2,"emoji":1}'::jsonb;

commit;
