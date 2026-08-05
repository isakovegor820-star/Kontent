begin;

alter table rss_items add column if not exists skip_reason text;
alter table rss_feeds add column if not exists publish_existing boolean not null default false;

-- Все исторические skipped до появления причины создавались только дневным лимитом.
update rss_items
   set skip_reason = 'limit'
 where status = 'skipped' and skip_reason is null;

alter table rss_items drop constraint if exists rss_items_skip_reason_check;
alter table rss_items
  add constraint rss_items_skip_reason_check
  check (skip_reason in ('limit', 'irrelevant', 'baseline', 'paused'));

commit;
