begin;

-- Release A separates source material, editable publication drafts and legacy records.
-- The default is deliberately fail-closed: only the application write boundary may mint
-- a publishable draft after it has classified the request.
alter table drafts add column if not exists purpose text not null default 'needs_review';
alter table drafts drop constraint if exists drafts_purpose_check;
alter table drafts add constraint drafts_purpose_check check (
  purpose in ('source_context', 'publishable', 'needs_review')
);

update drafts
   set purpose = case
     when origin in ('trend', 'idea', 'competitor') then 'source_context'
     when origin = 'manual' then 'publishable'
     else 'needs_review'
   end;

create table if not exists generation_operations (
  id                     bigint generated always as identity primary key,
  user_id                bigint not null references users (id) on delete cascade,
  ai_usage_id            bigint not null references ai_usage (id) on delete restrict,
  request_key            varchar(128) not null,
  server_request_id      uuid not null,
  request_fingerprint    char(64) not null,
  channel_id             bigint not null references channels (id) on delete restrict,
  source_context_id      bigint references drafts (id) on delete restrict,
  source_context_version bigint,
  input_draft_id         bigint references drafts (id) on delete restrict,
  input_draft_version    bigint,
  provider_engine        varchar(80) not null,
  provider_model         varchar(160) not null,
  status                 text not null default 'running',
  error_code             varchar(100),
  retryable              boolean not null default false,
  acknowledged_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (user_id, request_key),
  unique (ai_usage_id),
  check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  check (status in ('running', 'pending_ack', 'acknowledged', 'failed', 'retryable_failed')),
  check ((source_context_id is null) = (source_context_version is null)),
  check ((input_draft_id is null) = (input_draft_version is null)),
  check (source_context_version is null or source_context_version > 0),
  check (input_draft_version is null or input_draft_version > 0)
);

create unique index if not exists generation_operations_user_request_id_uniq
  on generation_operations (user_id, server_request_id);
create index if not exists generation_operations_recovery_idx
  on generation_operations (user_id, status, updated_at desc);

create table if not exists generation_results (
  id                bigint generated always as identity primary key,
  operation_id      bigint not null references generation_operations (id) on delete restrict,
  result_hash       char(64) not null check (result_hash ~ '^[0-9a-f]{64}$'),
  text              text not null,
  provider_result   jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  unique (operation_id)
);

create table if not exists validation_receipts (
  id                   bigint generated always as identity primary key,
  generation_result_id bigint not null references generation_results (id) on delete restrict,
  result_hash          char(64) not null check (result_hash ~ '^[0-9a-f]{64}$'),
  status               text not null check (status in ('passed', 'blocked', 'not_checked')),
  receipt              jsonb not null,
  created_at           timestamptz not null default now(),
  unique (generation_result_id)
);

alter table drafts add column if not exists generation_result_id bigint
  references generation_results (id) on delete restrict;
create index if not exists drafts_generation_result_idx
  on drafts (generation_result_id) where generation_result_id is not null;
create index if not exists drafts_publishable_user_updated_idx
  on drafts (user_id, updated_at desc, id desc) where purpose <> 'source_context';

-- Publication operations expose an explicit recoverable terminal state when an external
-- network accepted a post but verification has not completed yet.
alter table publication_operations drop constraint if exists publication_operations_status_check;
alter table publication_operations add constraint publication_operations_status_check check (
  status in ('pending','partial','queued','published_unverified','published','failed')
);

-- RSS journal entries use the same immutable Source Context pipeline and cannot be
-- published until Studio produces a server-bound generation result.
alter table drafts drop constraint if exists drafts_origin_check;
alter table drafts add constraint drafts_origin_check check (
  origin in ('manual', 'ai', 'trend', 'idea', 'competitor', 'rss', 'autopilot')
);

commit;
