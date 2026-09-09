begin;

-- Monetary exposure is independent of the refundable user-visible generation allowance.
-- No tariffs or budgets are seeded: operators must supply explicit accepted values.
create table if not exists ai_spend_attempts (
  id uuid primary key,
  user_id bigint not null references users(id) on delete restrict,
  project_id bigint not null references projects(id) on delete restrict,
  provider varchar(80) not null,
  model varchar(160) not null,
  budget_date date not null default (now() at time zone 'UTC')::date,
  status text not null default 'reserved' check (status in ('reserved','succeeded','failed','unknown')),
  reserved_microusd bigint not null check (reserved_microusd > 0),
  charged_microusd bigint check (charged_microusd >= 0),
  tariff jsonb not null check (jsonb_typeof(tariff) = 'object'),
  input_token_bound bigint not null check (input_token_bound >= 0),
  output_token_bound bigint not null check (output_token_bound >= 0),
  unit_bound bigint not null default 0 check (unit_bound >= 0),
  input_tokens bigint check (input_tokens >= 0),
  output_tokens bigint check (output_tokens >= 0),
  usage_known boolean not null default false,
  created_at timestamptz not null default now(),
  lease_expires_at timestamptz not null default now() + interval '10 minutes',
  finalized_at timestamptz,
  check (usage_known = (input_tokens is not null and output_tokens is not null)),
  check ((status = 'reserved') = (finalized_at is null))
);
create index if not exists ai_spend_attempts_budget_idx on ai_spend_attempts(budget_date,user_id,project_id);
create index if not exists ai_spend_attempts_active_idx on ai_spend_attempts(lease_expires_at) where status='reserved';

-- Existing queued Radar runs can be attributed only by their explicit channel; no selected-project backfill.
alter table radar_search_runs add column if not exists project_id bigint references projects(id) on delete restrict;
create index if not exists radar_search_runs_project_idx on radar_search_runs(project_id,created_at desc);

-- Persist the initiating member of user-requested background Sites work.
alter table site_reports add column if not exists requested_by_user_id bigint references users(id) on delete restrict;
alter table site_articles add column if not exists generation_requested_by_user_id bigint references users(id) on delete restrict;

commit;
