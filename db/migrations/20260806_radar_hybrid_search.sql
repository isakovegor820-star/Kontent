begin;

-- Общий справочник только проверенных публичных Telegram-источников. Он не содержит
-- пользовательских данных: поисковые запросы и выдача живут в user-scoped таблицах ниже.
create table if not exists discovered_sources (
  id                  bigint generated always as identity primary key,
  network             text not null default 'tg',
  handle              text not null,
  canonical_url       text not null,
  title               text,
  description         text,
  subscribers         integer,
  last_post_at        timestamptz,
  posts_per_week      numeric(7,1),
  is_public           boolean not null default true,
  verification_status text not null default 'verified',
  provider            text not null,
  raw_data             jsonb not null default '{}'::jsonb,
  verified_at          timestamptz not null default now(),
  cache_expires_at     timestamptz not null default (now() + interval '24 hours'),
  tsv                  tsvector generated always as (
    to_tsvector('russian', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(handle, ''))
  ) stored,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint discovered_sources_network_handle_key unique (network, handle),
  constraint discovered_sources_network_check check (network in ('tg')),
  constraint discovered_sources_handle_check check (handle ~ '^[a-z][a-z0-9_]{3,31}$'),
  constraint discovered_sources_url_check check (canonical_url ~ '^https://t\.me/'),
  constraint discovered_sources_verification_check
    check (verification_status in ('verified','rejected','error')),
  constraint discovered_sources_raw_data_check check (jsonb_typeof(raw_data) = 'object')
);
create index if not exists discovered_sources_tsv_idx on discovered_sources using gin (tsv);
create index if not exists discovered_sources_cache_idx
  on discovered_sources (verification_status, cache_expires_at, verified_at desc);

create table if not exists radar_search_runs (
  id                bigint generated always as identity primary key,
  user_id           bigint not null references users (id) on delete cascade,
  channel_id        bigint references channels (id) on delete cascade,
  request_key       varchar(128) not null,
  query             varchar(200) not null,
  normalized_query  varchar(200) not null,
  status            text not null default 'queued',
  stage             text not null default 'queued',
  progress          smallint not null default 0,
  provider          text,
  local_count       integer not null default 0,
  external_count    integer not null default 0,
  error_code        varchar(80),
  error_message     varchar(500),
  queue_confirmed_at timestamptz,
  cache_expires_at  timestamptz not null default (now() + interval '24 hours'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz,
  constraint radar_search_runs_user_request_key unique (user_id, request_key),
  constraint radar_search_runs_query_check check (length(btrim(normalized_query)) between 2 and 200),
  constraint radar_search_runs_status_check
    check (status in ('queued','running','ready','partial','failed')),
  constraint radar_search_runs_stage_check
    check (stage in ('queued','discovering','verifying','ranking','ready','failed')),
  constraint radar_search_runs_progress_check check (progress between 0 and 100),
  constraint radar_search_runs_counts_check check (local_count >= 0 and external_count >= 0)
);
create index if not exists radar_search_runs_user_created_idx
  on radar_search_runs (user_id, created_at desc);
create index if not exists radar_search_runs_cache_idx
  on radar_search_runs (user_id, normalized_query, cache_expires_at desc)
  where status in ('ready','partial');
create index if not exists radar_search_runs_active_idx
  on radar_search_runs (status, updated_at)
  where status in ('queued','running');

-- Сырая находка внешнего провайдера хранится отдельно и не показывается до проверки.
create table if not exists radar_search_candidates (
  id               bigint generated always as identity primary key,
  run_id           bigint not null references radar_search_runs (id) on delete cascade,
  provider         text not null,
  raw_url          text not null,
  handle           text,
  canonical_key    text,
  verification_status text not null default 'pending',
  rejection_reason varchar(160),
  raw_data         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  verified_at      timestamptz,
  constraint radar_search_candidates_status_check
    check (verification_status in ('pending','verified','rejected','error')),
  constraint radar_search_candidates_raw_data_check check (jsonb_typeof(raw_data) = 'object'),
  constraint radar_search_candidates_run_key unique (run_id, canonical_key)
);
create index if not exists radar_search_candidates_run_idx
  on radar_search_candidates (run_id, verification_status, id);

-- Только прошедшие живую проверку результаты. user_id дублируется намеренно: любой action
-- можно ограничить владельцем без доверия к run_id из клиентского запроса.
create table if not exists radar_search_results (
  id                  bigint generated always as identity primary key,
  run_id              bigint not null references radar_search_runs (id) on delete cascade,
  user_id             bigint not null references users (id) on delete cascade,
  discovered_source_id bigint references discovered_sources (id) on delete set null,
  result_type         text not null,
  provider            text not null,
  canonical_key       text not null,
  url                 text not null,
  handle              text,
  external_id         bigint,
  title               text,
  description         text,
  text                text,
  posted_at           timestamptz,
  subscribers         integer,
  views               integer,
  reactions           integer,
  posts_per_week      numeric(7,1),
  last_post_at        timestamptz,
  relevance_score     smallint not null default 0,
  freshness_score     smallint not null default 0,
  activity_score      smallint not null default 0,
  trust_score         smallint not null default 0,
  quality_score       smallint not null default 0,
  reason              varchar(500) not null,
  verification_status text not null default 'verified',
  verified_at         timestamptz not null default now(),
  raw_data             jsonb not null default '{}'::jsonb,
  tsv                  tsvector generated always as (
    to_tsvector('russian', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(text, '') || ' ' || coalesce(handle, ''))
  ) stored,
  created_at           timestamptz not null default now(),
  constraint radar_search_results_run_key unique (run_id, canonical_key),
  constraint radar_search_results_type_check check (result_type in ('channel','post','trend')),
  constraint radar_search_results_url_check check (url ~ '^https://t\.me/'),
  constraint radar_search_results_verification_check check (verification_status in ('verified')),
  constraint radar_search_results_scores_check check (
    relevance_score between 0 and 100 and freshness_score between 0 and 100
    and activity_score between 0 and 100 and trust_score between 0 and 100
    and quality_score between 0 and 100
  ),
  constraint radar_search_results_raw_data_check check (jsonb_typeof(raw_data) = 'object')
);
create index if not exists radar_search_results_run_score_idx
  on radar_search_results (run_id, result_type, quality_score desc, id);
create index if not exists radar_search_results_user_idx
  on radar_search_results (user_id, created_at desc);
create index if not exists radar_search_results_tsv_idx on radar_search_results using gin (tsv);

-- Один внешний референс сохраняется в библиотеку выбранного канала только один раз.
create unique index if not exists saved_posts_discovery_source_uniq
  on saved_posts (user_id, channel_id, source_url)
  where kind = 'reference' and source_url is not null;

commit;
