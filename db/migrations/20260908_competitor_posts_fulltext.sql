begin;

-- Existing installations predate the baseline schema's generated search vector.
-- The radar route relies on this column for local competitor-post discovery.
alter table competitor_posts
  add column if not exists tsv tsvector
  generated always as (to_tsvector('russian', coalesce(text, ''))) stored;

create index if not exists competitor_posts_tsv_idx
  on competitor_posts using gin (tsv);

commit;
