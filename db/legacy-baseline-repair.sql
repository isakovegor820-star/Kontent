-- One-time, idempotent bridge for installations created before the incremental
-- migration journal was introduced.  The migration runner deliberately refuses
-- to guess when a baseline relation is absent, so we create only the five legacy
-- relations that were optional in early Aurora deployments.  Subsequent journaled
-- migrations evolve these minimal shapes to the current production contract.

begin;

-- A few very early installations already had the baseline relations, but not
-- the last columns that became part of the accepted pre-journal contract.
alter table content_brief
  add column if not exists quality jsonb not null default '{}'::jsonb;
alter table posts
  add column if not exists vk_post_id bigint;
alter table posts
  add column if not exists external_post_id text;

create table if not exists knowledge_chunks (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  source_id bigint not null references knowledge_sources (id) on delete cascade,
  kind text not null check (kind in ('voice', 'fact', 'law', 'case', 'qa', 'service')),
  text text not null,
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('russian', text)) stored,
  valid_until date,
  used_count integer not null default 0
);
create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists knowledge_chunks_tsv_idx on knowledge_chunks using gin (tsv);
create index if not exists knowledge_chunks_channel_kind_idx on knowledge_chunks (channel_id, kind);

create table if not exists saved_posts (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  text text not null,
  note text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists hashtag_sets (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  name text not null,
  tags text[] not null,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists rss_feeds (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  url text,
  title text,
  is_active boolean not null default true
);

alter table rss_feeds add column if not exists url text;
alter table rss_feeds add column if not exists title text;
alter table rss_feeds add column if not exists ai_summarize boolean not null default true;
alter table rss_feeds add column if not exists max_per_day integer not null default 3;
alter table rss_feeds add column if not exists last_fetched_at timestamptz;
alter table rss_feeds add column if not exists created_at timestamptz not null default now();
update rss_feeds set url = 'legacy://rss-feed/' || id::text where url is null;
alter table rss_feeds alter column url set not null;
create unique index if not exists rss_feeds_user_url_uniq on rss_feeds (user_id, url);
create index if not exists rss_feeds_user_idx on rss_feeds (user_id);

create table if not exists rss_items (
  id bigint generated always as identity primary key,
  feed_id bigint not null references rss_feeds (id) on delete cascade,
  guid text,
  title text,
  link text,
  summary text,
  published_at timestamptz,
  post_id bigint references posts (id) on delete set null,
  status text not null default 'new',
  fetched_at timestamptz not null default now()
);

alter table rss_items add column if not exists guid text;
alter table rss_items add column if not exists title text;
alter table rss_items add column if not exists link text;
alter table rss_items add column if not exists summary text;
alter table rss_items add column if not exists published_at timestamptz;
alter table rss_items add column if not exists fetched_at timestamptz not null default now();
update rss_items set guid = 'legacy-rss-item-' || id::text where guid is null;
alter table rss_items alter column guid set not null;
create unique index if not exists rss_items_feed_guid_uniq on rss_items (feed_id, guid);
create index if not exists rss_items_feed_idx on rss_items (feed_id, fetched_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'rss_items'::regclass and conname = 'rss_items_status_check'
  ) then
    alter table rss_items add constraint rss_items_status_check
      check (status in ('new', 'posted', 'skipped'));
  end if;
end
$$;

create table if not exists media_generations (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  kind text not null,
  status text not null default 'queued'
);

create table if not exists niche_alerts (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  keyword text not null,
  is_active boolean not null default true,
  last_notified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (channel_id, keyword)
);

create table if not exists niche_matches (
  id bigint generated always as identity primary key,
  alert_id bigint not null references niche_alerts (id) on delete cascade,
  competitor_post_id bigint not null references competitor_posts (id) on delete cascade,
  notified boolean not null default false,
  found_at timestamptz not null default now(),
  unique (alert_id, competitor_post_id)
);
create index if not exists niche_matches_alert_idx on niche_matches (alert_id, found_at desc);

create table if not exists gap_questions (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  channel_id bigint references channels (id) on delete cascade,
  topic text not null,
  question text not null,
  status text not null default 'pending' check (status in ('pending', 'answered', 'skipped')),
  answer text,
  created_at timestamptz not null default now(),
  answered_at timestamptz
);
create index if not exists gap_questions_user_pending_idx
  on gap_questions (user_id, status, created_at desc);

alter table channels drop constraint if exists channels_network_check;
alter table channels add constraint channels_network_check
  check (network in ('tg', 'vk', 'youtube', 'instagram', 'x', 'tiktok', 'linkedin'));
alter table channels add column if not exists youtube_channel_id text;
alter table channels add column if not exists instagram_account_id text;
alter table channels add column if not exists x_account_id text;
alter table channels add column if not exists tiktok_account_id text;
alter table channels add column if not exists linkedin_account_id text;

create table if not exists oauth_tokens (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  provider text not null,
  external_id text,
  access_token text not null,
  refresh_token text,
  scopes text,
  expires_at timestamptz,
  meta jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists oauth_tokens_user_idx on oauth_tokens (user_id, provider);
create unique index if not exists oauth_tokens_active_uniq
  on oauth_tokens (user_id, provider, external_id)
  where is_active and external_id is not null;

alter table channels add column if not exists oauth_token_id bigint
  references oauth_tokens (id) on delete set null;
create unique index if not exists channels_youtube_active_uniq
  on channels (youtube_channel_id) where youtube_channel_id is not null and is_active;
create unique index if not exists channels_instagram_active_uniq
  on channels (instagram_account_id) where instagram_account_id is not null and is_active;
create unique index if not exists channels_x_active_uniq
  on channels (x_account_id) where x_account_id is not null and is_active;
create unique index if not exists channels_tiktok_active_uniq
  on channels (tiktok_account_id) where tiktok_account_id is not null and is_active;
create unique index if not exists channels_linkedin_active_uniq
  on channels (linkedin_account_id) where linkedin_account_id is not null and is_active;

commit;
