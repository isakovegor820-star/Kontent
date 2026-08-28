begin;

-- Общий не пользовательский индекс публичных веб-страниц. Поисковые запросы и
-- сформированные досье остаются в user-scoped radar_search_*; здесь накапливаются
-- только URL и ограниченный очищенный фрагмент уже публичной страницы.
create table if not exists radar_public_sources (
  id                  bigint generated always as identity primary key,
  canonical_url       text not null,
  domain              text not null,
  source_kind         text not null default 'other',
  title               text,
  description         text,
  content_sample      text,
  provider            text not null,
  verification_status text not null,
  trust_score         smallint not null default 0,
  raw_data             jsonb not null default '{}'::jsonb,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  verified_at          timestamptz,
  tsv                  tsvector generated always as (
    to_tsvector(
      'russian',
      coalesce(title, '') || ' ' || coalesce(description, '') || ' '
      || coalesce(content_sample, '') || ' ' || coalesce(domain, '')
    )
  ) stored,
  constraint radar_public_sources_url_key unique (canonical_url),
  constraint radar_public_sources_url_check check (canonical_url ~ '^https?://'),
  constraint radar_public_sources_domain_check check (
    length(domain) between 1 and 253 and domain !~ '[/?#@]'
  ),
  constraint radar_public_sources_kind_check check (
    source_kind in ('social','reference','profile','article','organization','other')
  ),
  constraint radar_public_sources_status_check check (
    verification_status in ('fetched','search_index')
  ),
  constraint radar_public_sources_trust_check check (trust_score between 0 and 100),
  constraint radar_public_sources_raw_data_check check (jsonb_typeof(raw_data) = 'object')
);
create index if not exists radar_public_sources_tsv_idx
  on radar_public_sources using gin (tsv);
create index if not exists radar_public_sources_domain_seen_idx
  on radar_public_sources (domain, last_seen_at desc);

alter table radar_search_results
  add column if not exists public_source_id bigint references radar_public_sources (id) on delete set null;

alter table radar_search_results drop constraint if exists radar_search_results_type_check;
alter table radar_search_results
  add constraint radar_search_results_type_check
  check (result_type in ('channel','post','trend','profile','source'));

alter table radar_search_results drop constraint if exists radar_search_results_url_check;
alter table radar_search_results
  add constraint radar_search_results_url_check check (url ~ '^https?://');

create index if not exists radar_search_results_public_source_idx
  on radar_search_results (public_source_id, created_at desc)
  where public_source_id is not null;

commit;
