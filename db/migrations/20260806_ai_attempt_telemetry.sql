begin;

create table if not exists ai_provider_attempts (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  ai_usage_id bigint references ai_usage (id) on delete set null,
  logical_operation_id uuid not null,
  phase text not null check (phase in ('draft','edit','auto-improve','topic-repair')),
  attempt_index integer not null check (attempt_index > 0),
  provider text not null,
  model text not null,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  usage_estimated boolean not null,
  latency_ms integer not null check (latency_ms >= 0),
  outcome text not null check (outcome in ('succeeded','failed','cancelled','budget_exhausted')),
  fallback boolean not null default false,
  estimated_cost_microusd bigint not null default 0 check (estimated_cost_microusd >= 0),
  safe_error_code text,
  request_correlation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (logical_operation_id, attempt_index)
);
create index if not exists ai_provider_attempts_user_created_idx
  on ai_provider_attempts (user_id, created_at desc);
create index if not exists ai_provider_attempts_operation_idx
  on ai_provider_attempts (logical_operation_id, attempt_index);

commit;
