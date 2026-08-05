begin;

create table if not exists site_analysis_jobs (
  id                  bigint generated always as identity primary key,
  user_id             bigint not null references users (id) on delete cascade,
  request_id          text not null unique,
  idempotency_key     text not null,
  request_fingerprint text not null,
  target_url          text not null,
  confirmed_domain    text not null,
  consented_at        timestamptz not null,
  status              text not null default 'queued',
  stage               text not null default 'queued',
  progress            integer not null default 0,
  progress_detail     text,
  limits              jsonb not null default '{}'::jsonb,
  result              jsonb,
  error_code          text,
  error_message       text,
  attempts            integer not null default 0,
  run_revision        integer not null default 1,
  last_retry_key      text,
  queue_confirmed_at  timestamptz,
  worker_lease_token  text,
  worker_heartbeat_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz,
  constraint site_analysis_jobs_status_check
    check (status in ('queued', 'crawling', 'analyzing', 'planning', 'ready', 'failed')),
  constraint site_analysis_jobs_stage_check
    check (stage in ('queued', 'robots', 'sitemap', 'crawling', 'analyzing', 'planning', 'ready', 'failed')),
  constraint site_analysis_jobs_progress_check check (progress between 0 and 100),
  constraint site_analysis_jobs_attempts_check check (attempts >= 0),
  constraint site_analysis_jobs_run_revision_check check (run_revision > 0),
  constraint site_analysis_jobs_limits_check check (jsonb_typeof(limits) = 'object'),
  constraint site_analysis_jobs_result_check check (result is null or jsonb_typeof(result) = 'object'),
  constraint site_analysis_jobs_user_idempotency_key_key unique (user_id, idempotency_key)
);

create index if not exists site_analysis_jobs_user_created_idx
  on site_analysis_jobs (user_id, created_at desc);
create index if not exists site_analysis_jobs_queued_idx
  on site_analysis_jobs (status, updated_at)
  where status in ('queued', 'crawling', 'analyzing', 'planning');

create table if not exists site_analysis_pages (
  id               bigint generated always as identity primary key,
  analysis_id      bigint not null references site_analysis_jobs (id) on delete cascade,
  url              text not null,
  http_status      integer not null,
  title            text,
  description      text,
  headings         jsonb not null default '[]'::jsonb,
  main_content     text,
  schema_types     text[] not null default '{}',
  links            jsonb not null default '[]'::jsonb,
  ctas             jsonb not null default '[]'::jsonb,
  forms            jsonb not null default '[]'::jsonb,
  public_comments  jsonb not null default '[]'::jsonb,
  technical        jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  constraint site_analysis_pages_headings_check check (jsonb_typeof(headings) = 'array'),
  constraint site_analysis_pages_links_check check (jsonb_typeof(links) = 'array'),
  constraint site_analysis_pages_ctas_check check (jsonb_typeof(ctas) = 'array'),
  constraint site_analysis_pages_forms_check check (jsonb_typeof(forms) = 'array'),
  constraint site_analysis_pages_public_comments_check check (jsonb_typeof(public_comments) = 'array'),
  constraint site_analysis_pages_technical_check check (jsonb_typeof(technical) = 'object'),
  constraint site_analysis_pages_analysis_id_url_key unique (analysis_id, url)
);

create index if not exists site_analysis_pages_analysis_idx
  on site_analysis_pages (analysis_id, id);

commit;
