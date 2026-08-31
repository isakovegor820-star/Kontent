begin;

create table if not exists aurora_releases (
  release_key varchar(128) primary key,
  commit_sha varchar(64),
  deployed_at timestamptz,
  first_observed_at timestamptz not null default now(),
  last_observed_at timestamptz not null default now(),
  constraint aurora_releases_key_check
    check (release_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  constraint aurora_releases_commit_check
    check (commit_sha is null or commit_sha ~ '^[0-9a-f]{7,64}$'),
  constraint aurora_releases_observation_check
    check (last_observed_at >= first_observed_at)
);

create index if not exists aurora_releases_deployed_idx
  on aurora_releases (deployed_at desc nulls last, release_key);

create table if not exists product_events (
  id bigint generated always as identity primary key,
  event_id uuid not null,
  project_id bigint not null references projects (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  section_id varchar(40) not null,
  feature_id varchar(64) not null,
  action varchar(64) not null,
  stage varchar(20) not null,
  outcome varchar(20) not null,
  duration_ms integer,
  error_code varchar(100),
  request_id varchar(128),
  operation_id varchar(128),
  release_key varchar(128) references aurora_releases (release_key) on delete restrict,
  session_id uuid,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  safe_context jsonb not null default '{}'::jsonb,
  important boolean not null default false,
  constraint product_events_section_check check (
    section_id in (
      'today','calendar','studio','autopilot','composer','library','rss','knowledge',
      'recon','opportunities','radar','siteAnalysis','growth','analytics','settings'
    )
  ),
  constraint product_events_identifier_check check (
    feature_id ~ '^[a-z][a-z0-9_]{0,63}$'
    and action ~ '^[a-z][a-z0-9_]{0,63}$'
  ),
  constraint product_events_stage_check check (
    stage in ('started','accepted','queued','processing','completed','failed','retried','cancelled')
  ),
  constraint product_events_outcome_check check (
    outcome in ('pending','success','failure','cancelled')
  ),
  constraint product_events_stage_outcome_check check (
    (stage <> 'failed' or outcome = 'failure')
    and (stage <> 'cancelled' or outcome = 'cancelled')
    and (outcome <> 'success' or stage in ('accepted','completed'))
  ),
  constraint product_events_duration_check check (
    duration_ms is null or duration_ms between 0 and 3600000
  ),
  constraint product_events_error_check check (
    error_code is null or error_code ~ '^[a-z0-9_]{1,100}$'
  ),
  constraint product_events_failure_code_check check (
    (stage <> 'failed' and outcome <> 'failure') or error_code is not null
  ),
  constraint product_events_request_check check (
    request_id is null or request_id ~ '^[A-Za-z0-9._:-]{1,128}$'
  ),
  constraint product_events_operation_check check (
    operation_id is null or operation_id ~ '^[A-Za-z0-9._:-]{1,128}$'
  ),
  constraint product_events_context_check check (
    jsonb_typeof(safe_context) = 'object'
    and safe_context - array[
      'device','source','operationKind','appVersion','queue','httpStatus','attempt','resultKind'
    ]::text[] = '{}'::jsonb
  ),
  unique (project_id, user_id, event_id)
);

create index if not exists product_events_section_time_idx
  on product_events (section_id, occurred_at desc, id desc);
create index if not exists product_events_project_time_idx
  on product_events (project_id, occurred_at desc, id desc);
create index if not exists product_events_user_time_idx
  on product_events (user_id, occurred_at desc, id desc);
create index if not exists product_events_request_idx
  on product_events (request_id, occurred_at desc)
  where request_id is not null;
create index if not exists product_events_operation_idx
  on product_events (operation_id, occurred_at desc)
  where operation_id is not null;
create index if not exists product_events_error_idx
  on product_events (error_code, occurred_at desc)
  where error_code is not null;
create index if not exists product_events_retention_idx
  on product_events (received_at, id);

create table if not exists product_event_daily (
  bucket_date date not null,
  project_id bigint not null references projects (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  section_id varchar(40) not null,
  feature_id varchar(64) not null,
  action varchar(64) not null,
  stage varchar(20) not null,
  outcome varchar(20) not null,
  error_code varchar(100) not null default '',
  release_key varchar(128) not null default '',
  device varchar(16) not null default 'unknown',
  event_count bigint not null default 0,
  success_count bigint not null default 0,
  failure_count bigint not null default 0,
  duration_samples bigint not null default 0,
  duration_total_ms bigint not null default 0,
  duration_min_ms integer,
  duration_max_ms integer,
  first_occurred_at timestamptz not null,
  last_occurred_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (
    bucket_date, project_id, user_id, section_id, feature_id, action,
    stage, outcome, error_code, release_key, device
  ),
  constraint product_event_daily_section_check check (
    section_id in (
      'today','calendar','studio','autopilot','composer','library','rss','knowledge',
      'recon','opportunities','radar','siteAnalysis','growth','analytics','settings'
    )
  ),
  constraint product_event_daily_device_check
    check (device in ('desktop','mobile','tablet','unknown')),
  constraint product_event_daily_counts_check check (
    event_count > 0
    and success_count >= 0
    and failure_count >= 0
    and duration_samples >= 0
    and duration_total_ms >= 0
  ),
  constraint product_event_daily_duration_check check (
    (duration_samples = 0 and duration_min_ms is null and duration_max_ms is null)
    or (
      duration_samples > 0
      and duration_min_ms between 0 and 3600000
      and duration_max_ms between duration_min_ms and 3600000
    )
  ),
  constraint product_event_daily_time_check
    check (last_occurred_at >= first_occurred_at)
);

create index if not exists product_event_daily_section_date_idx
  on product_event_daily (section_id, bucket_date desc);
create index if not exists product_event_daily_project_date_idx
  on product_event_daily (project_id, bucket_date desc);
create index if not exists product_event_daily_release_date_idx
  on product_event_daily (release_key, bucket_date desc)
  where release_key <> '';
create index if not exists product_event_daily_error_date_idx
  on product_event_daily (error_code, bucket_date desc)
  where error_code <> '';

-- Global administrators may read cross-project operational summaries. Keep a separate,
-- content-free access trail instead of overloading project-scoped audit_events.
create table if not exists admin_observation_events (
  id bigint generated always as identity primary key,
  actor_user_id bigint references users (id) on delete set null,
  action varchar(100) not null,
  target_type varchar(32) not null,
  target_id varchar(128),
  request_id varchar(128),
  safe_filters jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint admin_observation_events_action_check
    check (action in ('admin.system.read','admin.aurora_analytics.read')),
  constraint admin_observation_events_target_check
    check (target_type in ('runtime','project','section','component')),
  constraint admin_observation_events_target_id_check
    check (
      (target_type = 'runtime' and target_id is null)
      or (target_type <> 'runtime' and target_id ~ '^[A-Za-z0-9._:-]{1,128}$')
    ),
  constraint admin_observation_events_request_check
    check (request_id is null or request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  constraint admin_observation_events_filters_check
    check (
      jsonb_typeof(safe_filters) = 'object'
      and safe_filters - array[
        'range','from','to','projectId','segment','tenure','device','appVersion','release','sectionId','tab'
      ]::text[] = '{}'::jsonb
    )
);

create index if not exists admin_observation_events_actor_created_idx
  on admin_observation_events (actor_user_id, created_at desc, id desc);
create index if not exists admin_observation_events_action_created_idx
  on admin_observation_events (action, created_at desc, id desc);

commit;
