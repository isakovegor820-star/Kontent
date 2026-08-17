begin;

-- Сбор инфоповодов и разрешение на публикацию — разные действия.
-- По умолчанию новые и существующие юридические источники только наполняют подборку.
alter table rss_feeds
  add column if not exists auto_publish_enabled boolean not null default false;

commit;
