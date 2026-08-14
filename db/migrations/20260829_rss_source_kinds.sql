begin;

alter table rss_feeds
  add column source_kind text not null default 'manual'
  check (source_kind in ('manual', 'legal_opportunity'));

create index rss_feeds_user_source_kind_idx
  on rss_feeds (user_id, source_kind, channel_id, is_active);

commit;
