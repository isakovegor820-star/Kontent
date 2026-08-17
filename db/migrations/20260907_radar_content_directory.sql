begin;

-- Название канала не описывает его тему надёжно. Храним ограниченный срез только
-- публичных постов рядом с карточкой проверенного источника и ищем по нему так же,
-- как по названию и описанию. Вектор необязателен: если движок эмбеддингов недоступен,
-- полнотекстовая ветка и живой web-discovery продолжают работать.
alter table discovered_sources add column if not exists content_sample text;
alter table discovered_sources add column if not exists content_embedding vector(1024);
alter table discovered_sources add column if not exists indexed_posts_count integer not null default 0;
alter table discovered_sources add column if not exists content_indexed_at timestamptz;
alter table discovered_sources add column if not exists content_tsv tsvector
  generated always as (
    to_tsvector(
      'russian',
      coalesce(title, '') || ' ' || coalesce(description, '') || ' '
      || coalesce(handle, '') || ' ' || coalesce(content_sample, '')
    )
  ) stored;

alter table discovered_sources
  add constraint discovered_sources_indexed_posts_count_check check (indexed_posts_count >= 0) not valid;
alter table discovered_sources validate constraint discovered_sources_indexed_posts_count_check;

create index if not exists discovered_sources_content_tsv_idx
  on discovered_sources using gin (content_tsv);
create index if not exists discovered_sources_content_embedding_idx
  on discovered_sources using hnsw (content_embedding vector_cosine_ops);

-- Уже собранные конкурентные каналы содержат только публичные t.me/s-посты. Переносим
-- их в общий справочник без связи с человеком: база становится полезнее с каждым
-- проверенным каналом, но не раскрывает, кто именно его добавил.
with competitor_corpus as (
  select lower(competitor.handle) as handle,
         max(competitor.title) as title,
         max(competitor.subscribers) as subscribers,
         max(post.posted_at) as last_post_at,
         count(distinct (competitor.id, coalesce(post.external_post_id, post.tg_msg_id::text)))::integer
           as indexed_posts_count,
         left(string_agg(distinct nullif(btrim(post.text), ''), E'\n\n'), 24000) as content_sample
    from competitors competitor
    join competitor_posts post on post.competitor_id = competitor.id
   where competitor.network = 'tg'
     and competitor.is_active = true
     and competitor.status = 'ready'
     and lower(competitor.handle) ~ '^[a-z][a-z0-9_]{3,31}$'
     and nullif(btrim(post.text), '') is not null
   group by lower(competitor.handle)
)
insert into discovered_sources
  (network, handle, canonical_url, title, subscribers, last_post_at, is_public,
   verification_status, provider, raw_data, verified_at, cache_expires_at,
   content_sample, indexed_posts_count, content_indexed_at)
select 'tg', corpus.handle, 'https://t.me/' || corpus.handle, corpus.title,
       corpus.subscribers, corpus.last_post_at, true, 'verified', 'platform-public-corpus',
       jsonb_build_object('corpus', 'competitor_posts'), now(), now() + interval '24 hours',
       corpus.content_sample, corpus.indexed_posts_count, now()
  from competitor_corpus corpus
on conflict (network, handle) do update set
  title = coalesce(excluded.title, discovered_sources.title),
  subscribers = coalesce(excluded.subscribers, discovered_sources.subscribers),
  last_post_at = greatest(excluded.last_post_at, discovered_sources.last_post_at),
  content_sample = coalesce(excluded.content_sample, discovered_sources.content_sample),
  indexed_posts_count = greatest(excluded.indexed_posts_count, discovered_sources.indexed_posts_count),
  content_indexed_at = now(),
  updated_at = now();

with trend_corpus as (
  select lower(source.handle) as handle,
         max(source.title) as title,
         max(source.subscribers) as subscribers,
         max(post.posted_at) as last_post_at,
         count(distinct post.tg_msg_id)::integer as indexed_posts_count,
         left(string_agg(distinct nullif(btrim(post.text), ''), E'\n\n'), 24000) as content_sample
    from trend_sources source
    join trend_posts post on post.source_id = source.id
   where source.enabled = true
     and source.status = 'ready'
     and lower(source.handle) ~ '^[a-z][a-z0-9_]{3,31}$'
     and nullif(btrim(post.text), '') is not null
   group by lower(source.handle)
)
insert into discovered_sources
  (network, handle, canonical_url, title, subscribers, last_post_at, is_public,
   verification_status, provider, raw_data, verified_at, cache_expires_at,
   content_sample, indexed_posts_count, content_indexed_at)
select 'tg', corpus.handle, 'https://t.me/' || corpus.handle, corpus.title,
       corpus.subscribers, corpus.last_post_at, true, 'verified', 'platform-public-corpus',
       jsonb_build_object('corpus', 'trend_posts'), now(), now() + interval '24 hours',
       corpus.content_sample, corpus.indexed_posts_count, now()
  from trend_corpus corpus
on conflict (network, handle) do update set
  title = coalesce(excluded.title, discovered_sources.title),
  subscribers = coalesce(excluded.subscribers, discovered_sources.subscribers),
  last_post_at = greatest(excluded.last_post_at, discovered_sources.last_post_at),
  content_sample = coalesce(excluded.content_sample, discovered_sources.content_sample),
  indexed_posts_count = greatest(excluded.indexed_posts_count, discovered_sources.indexed_posts_count),
  content_indexed_at = now(),
  updated_at = now();

commit;
