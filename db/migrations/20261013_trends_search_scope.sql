begin;

-- Search ownership is recorded without removing the previous release's uniqueness
-- constraint, so old web and worker processes remain usable after an application rollback.
alter table radar_search_runs add column if not exists project_id bigint references projects (id) on delete cascade;
update radar_search_runs run set project_id = channel.project_id
  from channels channel where channel.id = run.channel_id and run.project_id is null;
update radar_search_runs run set project_id = project.id
  from projects project where project.personal_owner_user_id = run.user_id and run.project_id is null;

-- Persist search options across cache hits, retries and queue recovery.
alter table radar_search_runs add column if not exists search_scope text not null default 'all';
alter table radar_search_runs add column if not exists search_period text not null default 'month';
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'radar_search_runs'::regclass and conname = 'radar_search_runs_scope_check') then
    alter table radar_search_runs add constraint radar_search_runs_scope_check
      check (search_scope in ('all', 'telegram')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'radar_search_runs'::regclass and conname = 'radar_search_runs_period_check') then
    alter table radar_search_runs add constraint radar_search_runs_period_check
      check (search_period in ('day', 'week', 'month', 'quarter')) not valid;
  end if;
end $$;
alter table radar_search_runs validate constraint radar_search_runs_scope_check;
alter table radar_search_runs validate constraint radar_search_runs_period_check;
create index if not exists radar_search_runs_topic_idx
  on radar_search_runs (project_id, user_id, channel_id, normalized_query, created_at desc);

commit;
