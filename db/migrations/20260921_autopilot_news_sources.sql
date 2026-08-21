begin;

-- Autopilot chooses its own curated news perimeter from the channel brief. Persist that
-- server-owned selection per channel so manual builds and the weekly worker use the same
-- source set without asking the user to configure RSS feeds.
alter table autopilot_settings
  add column if not exists news_sources jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'autopilot_settings'::regclass
       and conname = 'autopilot_settings_news_sources_check'
  ) then
    alter table autopilot_settings
      add constraint autopilot_settings_news_sources_check
      check (jsonb_typeof(news_sources) = 'array');
  end if;
end
$$;

commit;
