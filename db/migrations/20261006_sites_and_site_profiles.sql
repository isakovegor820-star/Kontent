begin;

-- Сайт клиента как долгоживущая сущность проекта. Отдельный прогон анализа
-- (site_analysis_jobs) остаётся одноразовым срезом; сайт хранит подтверждение
-- владения доменом, режим публикации и ссылки на актуальный профиль и анализ.
-- См. docs/site-publishing-and-seo-spec.md, раздел 4.1 и решение 13.6/13.7.
create table if not exists sites (
  id                   bigint generated always as identity primary key,
  project_id           bigint not null references projects (id) on delete restrict,
  user_id              bigint not null references users (id) on delete cascade,
  confirmed_domain     text not null,
  canonical_url        text not null,
  verification_state   text not null default 'unverified',
  verification_method  text,
  verification_token   text not null,
  verified_at          timestamptz,
  latest_analysis_id   bigint references site_analysis_jobs (id) on delete set null,
  latest_profile_id    bigint,
  publishing_mode      text not null default 'confirm',
  auto_unlock_streak   integer not null default 10,
  approved_streak      integer not null default 0,
  cadence              jsonb not null default '{}'::jsonb,
  status               text not null default 'active',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint sites_project_domain_uniq unique (project_id, confirmed_domain),
  constraint sites_domain_check check (
    length(confirmed_domain) between 1 and 253 and confirmed_domain !~ '[/?#@\s]'
  ),
  constraint sites_canonical_url_check check (canonical_url ~ '^https?://'),
  constraint sites_verification_state_check check (
    verification_state in ('unverified', 'verified', 'revoked')
  ),
  constraint sites_verification_method_check check (
    verification_method is null or verification_method in ('dns_txt', 'meta_tag')
  ),
  constraint sites_verification_token_check check (length(verification_token) between 16 and 128),
  constraint sites_publishing_mode_check check (publishing_mode in ('confirm', 'auto')),
  constraint sites_auto_unlock_streak_check check (auto_unlock_streak > 0),
  constraint sites_approved_streak_check check (approved_streak >= 0),
  constraint sites_cadence_check check (jsonb_typeof(cadence) = 'object'),
  constraint sites_status_check check (status in ('active', 'paused', 'disconnected'))
);
create index if not exists sites_project_created_idx
  on sites (project_id, created_at desc, id desc);

-- Профиль сайта: выводы поверх инвентаря страниц одного прогона анализа.
-- Инвентарь не дублируется — он остаётся в site_analysis_pages / site_analysis_sources.
create table if not exists site_profiles (
  id                 bigint generated always as identity primary key,
  site_id            bigint not null references sites (id) on delete cascade,
  analysis_job_id    bigint references site_analysis_jobs (id) on delete set null,
  run_revision       integer not null default 1,
  profile_version    text not null default 'site-profile-v1',
  page_count         integer not null default 0,
  publication_count  integer not null default 0,
  topics             jsonb not null default '[]'::jsonb,
  gaps               jsonb not null default '[]'::jsonb,
  technical          jsonb not null default '{}'::jsonb,
  linkable_pages     jsonb not null default '[]'::jsonb,
  summary            text,
  created_at         timestamptz not null default now(),
  constraint site_profiles_run_revision_check check (run_revision > 0),
  constraint site_profiles_counts_check check (
    page_count >= 0 and publication_count >= 0 and publication_count <= page_count
  ),
  constraint site_profiles_topics_check check (jsonb_typeof(topics) = 'array'),
  constraint site_profiles_gaps_check check (jsonb_typeof(gaps) = 'array'),
  constraint site_profiles_technical_check check (jsonb_typeof(technical) = 'object'),
  constraint site_profiles_linkable_pages_check check (jsonb_typeof(linkable_pages) = 'array')
);
create index if not exists site_profiles_site_created_idx
  on site_profiles (site_id, created_at desc, id desc);
create unique index if not exists site_profiles_site_analysis_revision_uniq
  on site_profiles (site_id, analysis_job_id, run_revision)
  where analysis_job_id is not null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sites_latest_profile_fkey') then
    alter table sites
      add constraint sites_latest_profile_fkey
      foreign key (latest_profile_id) references site_profiles (id) on delete set null;
  end if;
end $$;

-- Отчёты по сайту. payload — источник истины, файлы рендерятся из него по запросу.
create table if not exists site_reports (
  id                  bigint generated always as identity primary key,
  site_id             bigint not null references sites (id) on delete cascade,
  kind                text not null,
  period_start        timestamptz,
  period_end          timestamptz,
  profile_id          bigint references site_profiles (id) on delete set null,
  previous_report_id  bigint references site_reports (id) on delete set null,
  probe_run_key       text,
  payload             jsonb not null,
  summary_ru          text not null,
  status              text not null default 'ready',
  created_at          timestamptz not null default now(),
  constraint site_reports_kind_check check (kind in ('initial_audit', 'monthly', 'on_demand')),
  constraint site_reports_status_check check (status in ('generating', 'ready', 'failed')),
  constraint site_reports_payload_check check (jsonb_typeof(payload) = 'object'),
  constraint site_reports_period_check check (
    period_start is null or period_end is null or period_start <= period_end
  )
);
create index if not exists site_reports_site_created_idx
  on site_reports (site_id, created_at desc, id desc);

-- Прогон анализа, запущенный от имени сайта. Существующий конвейер не меняется:
-- worker после стадии saving достраивает профиль и стартовый отчёт для job с site_id.
alter table site_analysis_jobs
  add column if not exists site_id bigint references sites (id) on delete set null;
create index if not exists site_analysis_jobs_site_created_idx
  on site_analysis_jobs (site_id, created_at desc, id desc)
  where site_id is not null;

commit;
