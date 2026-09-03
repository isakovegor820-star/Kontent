begin;

-- Этапы 2–5 спецификации docs/site-publishing-and-seo-spec.md: назначения публикации,
-- материалы для сайта, операции публикации, зонд видимости и база знаний сайта.

-- Служебный поддомен хостируемого раздела (<slug>.sites.<домен Авроры>). Решение 13.1.
alter table sites add column if not exists hosted_slug text;
alter table sites add column if not exists brand_name text;
create unique index if not exists sites_hosted_slug_uniq on sites (hosted_slug) where hosted_slug is not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'sites_hosted_slug_check') then
    alter table sites add constraint sites_hosted_slug_check
      check (hosted_slug is null or hosted_slug ~ '^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$');
  end if;
end $$;

-- Куда физически публикуем. Учётные данные — только AES-GCM-конверт (src/lib/token-crypto.mjs).
create table if not exists site_destinations (
  id                bigint generated always as identity primary key,
  site_id           bigint not null references sites (id) on delete cascade,
  kind              text not null,
  base_url          text not null,
  credentials       text,
  credential_state  text not null default 'not_configured',
  section_path      text,
  settings          jsonb not null default '{}'::jsonb,
  status            text not null default 'active',
  last_verified_at  timestamptz,
  last_error_code   text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint site_destinations_site_kind_uniq unique (site_id, kind),
  constraint site_destinations_kind_check check (kind in ('wordpress', 'site_hosted')),
  constraint site_destinations_base_url_check check (base_url ~ '^https?://'),
  constraint site_destinations_credential_state_check check (
    credential_state in ('not_required', 'ready', 'not_configured', 'expired', 'revoked', 'invalid', 'unknown')
  ),
  constraint site_destinations_settings_check check (jsonb_typeof(settings) = 'object'),
  constraint site_destinations_status_check check (status in ('active', 'needs_reconnect', 'revoked', 'disconnected'))
);
create index if not exists site_destinations_site_idx on site_destinations (site_id, kind);

-- Материалы для сайта. Живут отдельно от drafts: у статьи есть slug, SEO-поля, HTML и ревизии.
create table if not exists site_articles (
  id                bigint generated always as identity primary key,
  site_id           bigint not null references sites (id) on delete cascade,
  project_id        bigint not null references projects (id) on delete restrict,
  user_id           bigint not null references users (id) on delete cascade,
  article_type      text not null,
  origin            text not null,
  source_key        text,
  source_ref        jsonb,
  title             text not null default '',
  slug              text not null,
  meta_description  text,
  body_markdown     text not null default '',
  body_html         text,
  internal_links    jsonb not null default '[]'::jsonb,
  structured_data   jsonb,
  evidence_keys     jsonb not null default '[]'::jsonb,
  similarity_check  jsonb,
  quality           jsonb,
  generation        jsonb,
  version           bigint not null default 1,
  status            text not null default 'draft',
  status_reason     text,
  approved_by       bigint references users (id) on delete set null,
  approved_version  bigint,
  approved_at       timestamptz,
  published_url     text,
  provider_ref      jsonb,
  scheduled_at      timestamptz,
  published_at      timestamptz,
  retired_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint site_articles_site_slug_uniq unique (site_id, slug),
  constraint site_articles_type_check check (article_type in (
    'company_news', 'industry_explainer', 'audience_answer', 'evergreen_guide', 'case_study', 'machine_readable_page'
  )),
  constraint site_articles_origin_check check (origin in ('rss', 'channel_post', 'audience_question', 'gap', 'manual')),
  constraint site_articles_slug_check check (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$'),
  constraint site_articles_version_check check (version > 0),
  constraint site_articles_status_check check (status in (
    'draft', 'generating', 'needs_review', 'approved', 'scheduled', 'publishing', 'published', 'failed', 'rejected', 'retired'
  )),
  constraint site_articles_internal_links_check check (jsonb_typeof(internal_links) = 'array'),
  constraint site_articles_evidence_keys_check check (jsonb_typeof(evidence_keys) = 'array'),
  constraint site_articles_source_ref_check check (source_ref is null or jsonb_typeof(source_ref) = 'object'),
  constraint site_articles_approved_check check (
    (approved_at is null) = (approved_by is null) and (approved_at is null) = (approved_version is null)
  )
);
create index if not exists site_articles_site_status_idx on site_articles (site_id, status, updated_at desc, id desc);
create index if not exists site_articles_site_published_idx on site_articles (site_id, published_at desc) where status = 'published';
-- Один источник — один материал (решение 3 спецификации).
create unique index if not exists site_articles_site_source_uniq on site_articles (site_id, source_key) where source_key is not null;

create table if not exists site_article_revisions (
  id               bigint generated always as identity primary key,
  article_id       bigint not null references site_articles (id) on delete cascade,
  version          bigint not null,
  author_user_id   bigint references users (id) on delete set null,
  change_kind      text not null,
  content_hash     text not null,
  snapshot         jsonb not null,
  created_at       timestamptz not null default now(),
  constraint site_article_revisions_article_version_uniq unique (article_id, version),
  constraint site_article_revisions_version_check check (version > 0),
  constraint site_article_revisions_change_kind_check check (change_kind in ('generated', 'edited', 'approved', 'rejected', 'published', 'retired')),
  constraint site_article_revisions_snapshot_check check (jsonb_typeof(snapshot) = 'object')
);

-- Операция публикации статьи. Отдельная от publication_operations: та привязана к постам
-- (text + media + destination_ids), а здесь — версия статьи и одно назначение. Контракт
-- исходов тот же: success / definite_failure / delivery_unknown / rate_limited / auth_failed.
create table if not exists site_article_publications (
  id                    bigint generated always as identity primary key,
  article_id            bigint not null references site_articles (id) on delete cascade,
  destination_id        bigint not null references site_destinations (id) on delete cascade,
  article_version       bigint not null,
  idempotency_key       text not null,
  action                text not null default 'publish',
  status                text not null default 'pending',
  outcome               text,
  provider_operation_id text,
  provider_ref          jsonb,
  published_url         text,
  attempts              integer not null default 0,
  last_error_code       text,
  reconcile_state       text not null default 'none',
  worker_lease_token    text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  completed_at          timestamptz,
  constraint site_article_publications_idempotency_uniq unique (idempotency_key),
  constraint site_article_publications_article_version_uniq unique (article_id, destination_id, article_version, action),
  constraint site_article_publications_action_check check (action in ('publish', 'update', 'unpublish')),
  constraint site_article_publications_status_check check (
    status in ('pending', 'publishing', 'published_unverified', 'published', 'failed', 'cancelled')
  ),
  constraint site_article_publications_outcome_check check (
    outcome is null or outcome in ('success', 'definite_failure', 'delivery_unknown', 'rate_limited', 'auth_failed')
  ),
  constraint site_article_publications_reconcile_check check (reconcile_state in ('none', 'pending', 'confirmed', 'unresolved', 'failed')),
  constraint site_article_publications_attempts_check check (attempts >= 0)
);
create index if not exists site_article_publications_pending_idx
  on site_article_publications (status, updated_at) where status in ('pending', 'publishing', 'published_unverified');

-- Зонд видимости: один и тот же набор вопросов × движков, ценность — в динамике.
create table if not exists site_visibility_probes (
  id                     bigint generated always as identity primary key,
  site_id                bigint not null references sites (id) on delete cascade,
  run_key                text not null,
  question_key           text not null,
  question_text          text not null,
  engine                 text not null,
  brand_mentioned        boolean not null,
  site_cited             boolean not null,
  competitors_mentioned  jsonb not null default '[]'::jsonb,
  answer_excerpt         text,
  status                 text not null default 'answered',
  checked_at             timestamptz not null default now(),
  constraint site_visibility_probes_run_uniq unique (site_id, run_key, question_key, engine),
  constraint site_visibility_probes_competitors_check check (jsonb_typeof(competitors_mentioned) = 'array'),
  constraint site_visibility_probes_status_check check (status in ('answered', 'skipped_budget', 'failed'))
);
create index if not exists site_visibility_probes_site_run_idx on site_visibility_probes (site_id, checked_at desc, run_key);

-- База знаний сайта (раздел 4.4). Источник принадлежит либо каналу, либо сайту.
-- Таблицы знаний исторически создавались только bootstrap-схемой; для баз, поднятых
-- из legacy-пути, создаём их здесь в целевой форме (pgvector подключён миграцией 20260906).
create table if not exists knowledge_sources (
  id          bigint generated always as identity primary key,
  user_id     bigint      not null references users (id) on delete cascade,
  channel_id  bigint      references channels (id) on delete cascade,
  kind        text        not null,
  title       text        not null,
  raw_text    text        not null,
  status      text        not null default 'pending'
                          check (status in ('pending', 'ready', 'error')),
  last_error  text,
  added_at    timestamptz not null default now(),
  indexed_at  timestamptz
);
create index if not exists knowledge_sources_channel_idx on knowledge_sources (channel_id);
create table if not exists knowledge_chunks (
  id          bigint generated always as identity primary key,
  user_id     bigint      not null references users (id) on delete cascade,
  channel_id  bigint      references channels (id) on delete cascade,
  source_id   bigint      not null references knowledge_sources (id) on delete cascade,
  kind        text        not null
                          check (kind in ('voice', 'fact', 'law', 'case', 'qa', 'service')),
  text        text        not null,
  embedding   vector(1024),
  tsv         tsvector generated always as (to_tsvector('russian', text)) stored,
  valid_until date,
  used_count  int         not null default 0
);
create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists knowledge_chunks_tsv_idx on knowledge_chunks using gin (tsv);
create index if not exists knowledge_chunks_channel_kind_idx on knowledge_chunks (channel_id, kind);

alter table knowledge_sources add column if not exists site_id bigint references sites (id) on delete cascade;
alter table knowledge_sources alter column channel_id drop not null;
alter table knowledge_sources drop constraint if exists knowledge_sources_kind_check;
alter table knowledge_sources add constraint knowledge_sources_kind_check
  check (kind in ('form', 'paste', 'channel', 'profile', 'profile_edit', 'site_page', 'site_publication', 'site_report'));
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'knowledge_sources_owner_check') then
    alter table knowledge_sources add constraint knowledge_sources_owner_check
      check ((channel_id is not null)::int + (site_id is not null)::int = 1);
  end if;
end $$;
create index if not exists knowledge_sources_site_idx on knowledge_sources (site_id, kind) where site_id is not null;

alter table knowledge_chunks add column if not exists site_id bigint references sites (id) on delete cascade;
alter table knowledge_chunks alter column channel_id drop not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'knowledge_chunks_owner_check') then
    alter table knowledge_chunks add constraint knowledge_chunks_owner_check
      check ((channel_id is not null)::int + (site_id is not null)::int = 1);
  end if;
end $$;
create index if not exists knowledge_chunks_site_kind_idx on knowledge_chunks (site_id, kind) where site_id is not null;

commit;
