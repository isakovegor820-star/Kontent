begin;

-- Источник сначала только сохраняется. Автопубликацию пользователь включает отдельно.
alter table rss_feeds alter column is_active set default false;

-- paused помечает RSS-item, чей ещё не вышедший post отменён вместе с лентой.
alter table rss_items add column if not exists skip_reason text;
alter table rss_items drop constraint if exists rss_items_skip_reason_check;
alter table rss_items
  add constraint rss_items_skip_reason_check
  check (skip_reason in ('limit', 'irrelevant', 'baseline', 'paused'));

commit;
