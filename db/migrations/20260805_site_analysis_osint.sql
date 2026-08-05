-- Evidence-based OSINT interview for site analysis. Existing crawl rows and the legacy
-- result projection remain intact; normalized run data is append-only by run_revision.

begin;

alter table site_analysis_jobs
  add column if not exists prompt_version text not null default 'site-osint-interview-v1',
  add column if not exists question_catalog_version text not null default 'site-osint-questions-v1',
  add column if not exists snapshot_hash text,
  add column if not exists coverage_mode text not null default 'site_only',
  add column if not exists answered_count integer not null default 0,
  add column if not exists question_count integer not null default 0,
  add column if not exists ai_usage_reservation_id bigint references ai_usage (id) on delete set null;

alter table site_analysis_jobs drop constraint if exists site_analysis_jobs_status_check;
alter table site_analysis_jobs add constraint site_analysis_jobs_status_check check (
  status in ('queued', 'crawling', 'analyzing', 'planning', 'saving', 'ready', 'failed')
);
alter table site_analysis_jobs drop constraint if exists site_analysis_jobs_stage_check;
alter table site_analysis_jobs add constraint site_analysis_jobs_stage_check check (
  stage in (
    'queued', 'robots', 'sitemap', 'crawling', 'extracting', 'resolving_entities',
    'researching_external', 'answering', 'validating', 'planning', 'saving', 'ready', 'failed'
  )
);
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'site_analysis_jobs'::regclass
       and conname = 'site_analysis_jobs_snapshot_hash_check'
  ) then
    alter table site_analysis_jobs add constraint site_analysis_jobs_snapshot_hash_check check (
      snapshot_hash is null or snapshot_hash ~ '^sha256:[a-f0-9]{64}$'
    );
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'site_analysis_jobs'::regclass
       and conname = 'site_analysis_jobs_coverage_mode_check'
  ) then
    alter table site_analysis_jobs add constraint site_analysis_jobs_coverage_mode_check check (
      coverage_mode in ('site_only', 'external')
    );
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'site_analysis_jobs'::regclass
       and conname = 'site_analysis_jobs_answer_counts_check'
  ) then
    alter table site_analysis_jobs add constraint site_analysis_jobs_answer_counts_check check (
      answered_count >= 0 and question_count >= 0 and answered_count <= question_count
    );
  end if;
end $$;

create table if not exists site_analysis_sources (
  id             bigint generated always as identity primary key,
  analysis_id    bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision   integer not null,
  source_key     text not null,
  source_kind    text not null,
  url            text not null,
  title          text not null,
  page_type      text not null,
  is_primary     boolean not null default false,
  published_at   timestamptz,
  modified_at    timestamptz,
  checked_at     timestamptz not null,
  quality        text not null,
  content_hash   text not null,
  metadata       jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint site_analysis_sources_revision_check check (run_revision > 0),
  constraint site_analysis_sources_kind_check check (source_kind in (
    'owned_page', 'owned_document', 'structured_data', 'external_editorial',
    'partner_page', 'event_page', 'official_social', 'public_registry', 'user_file'
  )),
  constraint site_analysis_sources_quality_check check (quality in ('high', 'medium', 'low', 'unavailable')),
  constraint site_analysis_sources_metadata_check check (jsonb_typeof(metadata) = 'object'),
  constraint site_analysis_sources_run_source_key unique (analysis_id, run_revision, source_key),
  constraint site_analysis_sources_run_url_key unique (analysis_id, run_revision, url)
);
create index if not exists site_analysis_sources_analysis_run_idx
  on site_analysis_sources (analysis_id, run_revision, id);

create table if not exists site_analysis_evidence (
  id                bigint generated always as identity primary key,
  analysis_id       bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision      integer not null,
  source_id         bigint not null references site_analysis_sources (id) on delete cascade,
  evidence_key      text not null,
  evidence_hash     text not null,
  evidence_type     text not null,
  fact_type         text not null,
  value             jsonb not null,
  extracted_by      text not null,
  quality           text not null,
  currentness       text not null,
  checked_at        timestamptz not null,
  published_at      timestamptz,
  injection_signal  boolean not null default false,
  created_at        timestamptz not null default now(),
  constraint site_analysis_evidence_revision_check check (run_revision > 0),
  constraint site_analysis_evidence_value_check check (jsonb_typeof(value) in ('string', 'number', 'boolean', 'object', 'array')),
  constraint site_analysis_evidence_quality_check check (quality in ('high', 'medium', 'low', 'unavailable')),
  constraint site_analysis_evidence_run_key unique (analysis_id, run_revision, evidence_key),
  constraint site_analysis_evidence_run_hash unique (analysis_id, run_revision, evidence_hash)
);
create index if not exists site_analysis_evidence_analysis_run_idx
  on site_analysis_evidence (analysis_id, run_revision, source_id, id);

create table if not exists site_analysis_entities (
  id              bigint generated always as identity primary key,
  analysis_id     bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision    integer not null,
  entity_key      text not null,
  entity_type     text not null,
  canonical_key   text not null,
  name            text not null,
  attributes      jsonb not null default '{}'::jsonb,
  evidence_keys   jsonb not null default '[]'::jsonb,
  confidence      text not null,
  created_at      timestamptz not null default now(),
  constraint site_analysis_entities_revision_check check (run_revision > 0),
  constraint site_analysis_entities_type_check check (entity_type in (
    'organization', 'person', 'product', 'partner', 'event', 'topic', 'channel', 'document'
  )),
  constraint site_analysis_entities_attributes_check check (jsonb_typeof(attributes) = 'object'),
  constraint site_analysis_entities_evidence_check check (jsonb_typeof(evidence_keys) = 'array'),
  constraint site_analysis_entities_confidence_check check (confidence in ('high', 'medium', 'low', 'none')),
  constraint site_analysis_entities_run_key unique (analysis_id, run_revision, entity_key),
  constraint site_analysis_entities_run_canonical unique (analysis_id, run_revision, entity_type, canonical_key)
);
create index if not exists site_analysis_entities_analysis_run_idx
  on site_analysis_entities (analysis_id, run_revision, entity_type, id);

create table if not exists site_analysis_relations (
  id                 bigint generated always as identity primary key,
  analysis_id        bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision       integer not null,
  relation_key       text not null,
  from_entity_key    text not null,
  to_entity_key      text not null,
  relation_type      text not null,
  relation_status    text not null,
  valid_from         timestamptz,
  valid_to           timestamptz,
  evidence_keys      jsonb not null default '[]'::jsonb,
  confidence         text not null,
  created_at         timestamptz not null default now(),
  constraint site_analysis_relations_revision_check check (run_revision > 0),
  constraint site_analysis_relations_status_check check (relation_status in ('observed', 'claimed', 'confirmed', 'historical', 'conflicting')),
  constraint site_analysis_relations_evidence_check check (jsonb_typeof(evidence_keys) = 'array'),
  constraint site_analysis_relations_confidence_check check (confidence in ('high', 'medium', 'low', 'none')),
  constraint site_analysis_relations_run_key unique (analysis_id, run_revision, relation_key)
);
create index if not exists site_analysis_relations_analysis_run_idx
  on site_analysis_relations (analysis_id, run_revision, relation_type, id);

create table if not exists site_analysis_ai_batches (
  id                       bigint generated always as identity primary key,
  analysis_id              bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision             integer not null,
  batch_id                 text not null,
  semantic_key             text not null,
  provider_request_key     text not null,
  request_fingerprint      text not null,
  status                   text not null default 'queued',
  engine                   text,
  response_payload         jsonb,
  error_code               text,
  attempts                 integer not null default 0,
  started_at               timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint site_analysis_ai_batches_revision_check check (run_revision > 0),
  constraint site_analysis_ai_batches_status_check check (status in ('queued', 'generating', 'ready', 'failed')),
  constraint site_analysis_ai_batches_response_check check (response_payload is null or jsonb_typeof(response_payload) = 'object'),
  constraint site_analysis_ai_batches_attempts_check check (attempts >= 0),
  constraint site_analysis_ai_batches_run_batch_key unique (analysis_id, run_revision, batch_id),
  constraint site_analysis_ai_batches_provider_key unique (provider_request_key)
);
create index if not exists site_analysis_ai_batches_dispatch_idx
  on site_analysis_ai_batches (status, updated_at) where status in ('queued', 'generating');

create table if not exists site_analysis_answers (
  id                    bigint generated always as identity primary key,
  analysis_id           bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision          integer not null,
  question_id           text not null,
  question_version      integer not null,
  status                text not null,
  short_answer          text not null,
  explanation           text not null,
  facts                 jsonb not null default '[]'::jsonb,
  evidence_keys         jsonb not null default '[]'::jsonb,
  confidence            text not null,
  contradictions        jsonb not null default '[]'::jsonb,
  gaps                   jsonb not null default '[]'::jsonb,
  required_integrations jsonb not null default '[]'::jsonb,
  recommendation_hooks  jsonb not null default '[]'::jsonb,
  created_at             timestamptz not null default now(),
  constraint site_analysis_answers_revision_check check (run_revision > 0),
  constraint site_analysis_answers_question_version_check check (question_version > 0),
  constraint site_analysis_answers_status_check check (status in ('answered', 'hypothesis', 'conflicting', 'insufficient_data')),
  constraint site_analysis_answers_confidence_check check (confidence in ('high', 'medium', 'low', 'none')),
  constraint site_analysis_answers_facts_check check (jsonb_typeof(facts) = 'array'),
  constraint site_analysis_answers_evidence_check check (jsonb_typeof(evidence_keys) = 'array'),
  constraint site_analysis_answers_contradictions_check check (jsonb_typeof(contradictions) = 'array'),
  constraint site_analysis_answers_gaps_check check (jsonb_typeof(gaps) = 'array'),
  constraint site_analysis_answers_integrations_check check (jsonb_typeof(required_integrations) = 'array'),
  constraint site_analysis_answers_hooks_check check (jsonb_typeof(recommendation_hooks) = 'array'),
  constraint site_analysis_answers_run_question_key unique (analysis_id, run_revision, question_id)
);
create index if not exists site_analysis_answers_analysis_run_idx
  on site_analysis_answers (analysis_id, run_revision, status, id);

create table if not exists site_analysis_recommendations (
  id              bigint generated always as identity primary key,
  analysis_id     bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision    integer not null,
  recommendation_key text not null,
  question_id     text not null,
  kind            text not null,
  rationale       text not null,
  confidence      text not null,
  entity_keys     jsonb not null default '[]'::jsonb,
  evidence_keys   jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now(),
  constraint site_analysis_recommendations_revision_check check (run_revision > 0),
  constraint site_analysis_recommendations_confidence_check check (confidence in ('high', 'medium', 'low')),
  constraint site_analysis_recommendations_entities_check check (jsonb_typeof(entity_keys) = 'array'),
  constraint site_analysis_recommendations_evidence_check check (jsonb_typeof(evidence_keys) = 'array'),
  constraint site_analysis_recommendations_run_key unique (analysis_id, run_revision, recommendation_key)
);
create index if not exists site_analysis_recommendations_analysis_run_idx
  on site_analysis_recommendations (analysis_id, run_revision, id);

commit;
