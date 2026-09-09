begin;

-- Keep the old account history intact. New history belongs to a project and an actor;
-- old account-only history is copied only into that actor's private personal project.
create table if not exists studio_project_chat_sessions (
  project_id bigint not null references projects (id) on delete cascade,
  user_id bigint not null references users (id) on delete cascade,
  payload jsonb not null,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (project_id, user_id),
  constraint studio_project_chat_sessions_payload_check check (jsonb_typeof(payload) = 'object'),
  constraint studio_project_chat_sessions_revision_check check (revision > 0)
);
insert into studio_project_chat_sessions (project_id, user_id, payload, revision, updated_at)
select project.id, history.user_id, history.payload, history.revision, history.updated_at
  from studio_chat_sessions history
  join projects project on project.personal_owner_user_id = history.user_id
on conflict (project_id, user_id) do nothing;

-- Adding the same feed to a different channel must never move an existing subscription.
-- The channel lock in the write service serializes subscriptions from different actors.
alter table rss_feeds drop constraint if exists rss_feeds_user_id_url_key;
create unique index if not exists rss_feeds_actor_channel_url_uidx on rss_feeds (user_id, channel_id, url);

-- A radar search with no selected channel still belongs to the project that started it.
alter table radar_search_runs add column if not exists project_id bigint references projects (id) on delete cascade;
update radar_search_runs run set project_id = channel.project_id
  from channels channel where channel.id = run.channel_id and run.project_id is null;
update radar_search_runs run set project_id = project.id
  from projects project where project.personal_owner_user_id = run.user_id and run.project_id is null;
alter table radar_search_runs drop constraint if exists radar_search_runs_user_request_key;
create unique index if not exists radar_search_runs_project_request_uidx on radar_search_runs (project_id, user_id, request_key);

commit;
