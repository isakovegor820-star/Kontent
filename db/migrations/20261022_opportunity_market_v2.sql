begin;

-- A confirmed channel brief is also the cold-start research profile. These fields are
-- deliberately additive: existing briefs remain usable and default to Russian/global.
alter table content_brief add column if not exists language varchar(16) not null default 'ru';
alter table content_brief add column if not exists region varchar(80);
alter table content_brief add column if not exists opportunity_keywords text[] not null default '{}';
alter table content_brief add column if not exists excluded_keywords text[] not null default '{}';
alter table content_brief add column if not exists research_profile_hash char(64);
alter table content_brief add column if not exists research_profile_updated_at timestamptz;

alter table content_brief drop constraint if exists content_brief_language_check;
alter table content_brief add constraint content_brief_language_check
  check (length(btrim(language)) between 2 and 16) not valid;
alter table content_brief validate constraint content_brief_language_check;
alter table content_brief drop constraint if exists content_brief_region_check;
alter table content_brief add constraint content_brief_region_check
  check (region is null or length(btrim(region)) between 2 and 80) not valid;
alter table content_brief validate constraint content_brief_region_check;
alter table content_brief drop constraint if exists content_brief_research_profile_hash_check;
alter table content_brief add constraint content_brief_research_profile_hash_check
  check (research_profile_hash is null or research_profile_hash ~ '^[0-9a-f]{64}$') not valid;
alter table content_brief validate constraint content_brief_research_profile_hash_check;

-- Global, public-only signal store. No tenant content may be copied into this table.
-- Multiple public sources for the same event are retained in market_signal_sources.
create table if not exists market_signals (
  id bigint generated always as identity primary key,
  kind text not null,
  canonical_hash char(64) not null unique,
  title varchar(300) not null,
  summary text not null default '',
  language varchar(16) not null default 'ru',
  region varchar(80),
  topic_keys text[] not null default '{}',
  entities text[] not null default '{}',
  momentum_score smallint not null default 0,
  trust_score smallint not null default 0,
  published_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  status text not null default 'active',
  raw_metadata jsonb not null default '{}'::jsonb,
  tsv tsvector generated always as (
    to_tsvector('russian', coalesce(title, '') || ' ' || coalesce(summary, ''))
  ) stored,
  constraint market_signals_kind_check
    check (kind in ('news','rising_topic','evergreen_gap','public_post')),
  constraint market_signals_title_check check (length(btrim(title)) between 3 and 300),
  constraint market_signals_language_check check (length(btrim(language)) between 2 and 16),
  constraint market_signals_region_check check (region is null or length(btrim(region)) between 2 and 80),
  constraint market_signals_score_check
    check (momentum_score between 0 and 100 and trust_score between 0 and 100),
  constraint market_signals_status_check check (status in ('active','stale','rejected')),
  constraint market_signals_metadata_check check (jsonb_typeof(raw_metadata) = 'object')
);
create index if not exists market_signals_active_seen_idx
  on market_signals (status, last_seen_at desc, id desc);
create index if not exists market_signals_tsv_idx on market_signals using gin (tsv);

create table if not exists market_signal_sources (
  id bigint generated always as identity primary key,
  signal_id bigint not null references market_signals (id) on delete cascade,
  provider varchar(80) not null,
  source_url text not null,
  source_url_hash char(64) not null,
  source_domain varchar(253) not null,
  source_title varchar(300),
  published_at timestamptz,
  fetched_at timestamptz not null default now(),
  is_primary boolean not null default false,
  trust_score smallint not null default 0,
  raw_metadata jsonb not null default '{}'::jsonb,
  constraint market_signal_sources_signal_url_uniq unique (signal_id, source_url_hash),
  constraint market_signal_sources_url_check check (source_url ~ '^https?://'),
  constraint market_signal_sources_domain_check
    check (length(source_domain) between 1 and 253 and source_domain !~ '[/?#@]'),
  constraint market_signal_sources_provider_check check (length(btrim(provider)) between 2 and 80),
  constraint market_signal_sources_url_hash_check check (source_url_hash ~ '^[0-9a-f]{64}$'),
  constraint market_signal_sources_trust_check check (trust_score between 0 and 100),
  constraint market_signal_sources_metadata_check check (jsonb_typeof(raw_metadata) = 'object')
);
create index if not exists market_signal_sources_signal_idx
  on market_signal_sources (signal_id, trust_score desc, fetched_at desc, id desc);

-- Keep the existing weekly growth loop and Studio flow, but allow public market sources.
alter table growth_moves drop constraint if exists growth_moves_source_kind_check;
alter table growth_moves add constraint growth_moves_source_kind_check
  check (source_kind is null or source_kind in (
    'competitor_post', 'site_analysis', 'audience_question', 'stats',
    'market_signal', 'news_event', 'trend_post', 'radar_result', 'rss_item', 'channel_profile'
  ));

alter table opportunity_snapshots add column if not exists opportunity_type text not null default 'evergreen_gap';
alter table opportunity_snapshots add column if not exists priority_score smallint not null default 0;
alter table opportunity_snapshots add column if not exists publish_before timestamptz;
alter table opportunity_snapshots add column if not exists source_count integer not null default 1;
alter table opportunity_snapshots add column if not exists profile_hash char(64);
alter table opportunity_snapshots drop constraint if exists opportunity_snapshots_type_check;
alter table opportunity_snapshots add constraint opportunity_snapshots_type_check
  check (opportunity_type in ('breaking_news','rising_topic','evergreen_gap','competitor_gap','audience_need','offer_gap'));
alter table opportunity_snapshots drop constraint if exists opportunity_snapshots_priority_check;
alter table opportunity_snapshots add constraint opportunity_snapshots_priority_check check (priority_score between 0 and 100);
alter table opportunity_snapshots drop constraint if exists opportunity_snapshots_source_count_check;
alter table opportunity_snapshots add constraint opportunity_snapshots_source_count_check check (source_count between 0 and 10000);
alter table opportunity_snapshots drop constraint if exists opportunity_snapshots_profile_hash_check;
alter table opportunity_snapshots add constraint opportunity_snapshots_profile_hash_check
  check (profile_hash is null or profile_hash ~ '^[0-9a-f]{64}$');
create index if not exists opportunity_snapshots_channel_rank_idx
  on opportunity_snapshots (project_id, channel_id, priority_score desc, expires_at desc, id desc);

create table if not exists opportunity_states (
  project_id bigint not null references projects (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  opportunity_snapshot_id bigint not null,
  state text not null,
  reason_code varchar(80),
  version bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id, channel_id, user_id, opportunity_snapshot_id),
  constraint opportunity_states_member_fk
    foreign key (project_id, user_id) references project_members (project_id, user_id) on delete cascade,
  constraint opportunity_states_channel_project_fk
    foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade,
  constraint opportunity_states_snapshot_scope_fk
    foreign key (opportunity_snapshot_id, project_id, channel_id)
    references opportunity_snapshots (id, project_id, channel_id) on delete cascade,
  constraint opportunity_states_state_check check (state in ('saved','dismissed','used','not_relevant')),
  constraint opportunity_states_reason_check
    check (reason_code is null or reason_code in ('wrong_topic','already_covered','weak_source','bad_timing','other')),
  constraint opportunity_states_version_check check (version > 0)
);
create index if not exists opportunity_states_user_state_idx
  on opportunity_states (user_id, project_id, channel_id, state, updated_at desc);

commit;
