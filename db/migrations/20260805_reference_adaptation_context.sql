begin;

-- Preserve content ideas as their own provenance instead of coercing them to competitors.
alter table drafts drop constraint if exists drafts_origin_check;
alter table drafts add constraint drafts_origin_check check (
  origin in ('manual', 'ai', 'trend', 'idea', 'competitor', 'autopilot')
);

-- A reference draft is normally adapted into an AI draft before publication, but keeping
-- the execution boundary compatible makes recovery/manual editing safe.
alter table posts drop constraint if exists posts_publication_origin_check;
alter table posts add constraint posts_publication_origin_check check (
  publication_origin in ('manual', 'ai', 'trend', 'idea', 'competitor', 'autopilot', 'rss', 'retry', 'legacy')
);

commit;
