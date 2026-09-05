begin;

-- The accepted sparse legacy schema has feed identities but no recoverable URL.
-- Preserve those rows with NULL URL/project; never invent a provider URL or bind
-- incomplete source data merely because an old channel has acquired a project.
alter table rss_feeds add column if not exists url text;

-- Bind existing feeds only to their actual channel. Unassigned legacy channels do
-- not acquire a guessed personal/current project and stay unavailable to runtimes.
alter table rss_feeds add column if not exists project_id bigint references projects(id) on delete restrict;
update rss_feeds feed set project_id=channel.project_id
  from channels channel where channel.id=feed.channel_id and feed.project_id is null
    and channel.project_id is not null and feed.url is not null;
create unique index if not exists rss_feeds_user_project_url_uniq on rss_feeds(user_id,project_id,url);
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='rss_feeds'::regclass and conname='rss_feeds_channel_project_fk') then
    alter table rss_feeds add constraint rss_feeds_channel_project_fk foreign key(channel_id,project_id)
      references channels(id,project_id) on delete cascade;
  end if;
end $$;
-- Cutover must drain old web/workers: their ON CONFLICT(user_id,url) is obsolete.
-- Restoring that global key after two projects use one URL is not a safe rollback.
alter table rss_feeds drop constraint if exists rss_feeds_user_id_url_key;
comment on column rss_feeds.project_id is 'Explicit RSS project identity; NULL legacy rows are held, never selected through a user preference.';

commit;
