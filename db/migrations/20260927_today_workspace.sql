begin;

-- Enable the daily workspace for active production channels that were never assigned
-- to an explicit rollout cohort. An explicit administrator decision is preserved:
-- rows carrying enabled_by_user_id are not changed by this backfill.
insert into channel_feature_flags (
  project_id,
  channel_id,
  feature_key,
  enabled,
  enabled_at
)
select channel.project_id,
       channel.id,
       'content_intelligence_release_1',
       true,
       now()
  from channels channel
 where channel.is_active = true
   and channel.status = 'active'
on conflict (project_id, channel_id, feature_key) do update
  set enabled = true,
      enabled_at = coalesce(channel_feature_flags.enabled_at, now()),
      updated_at = now()
where channel_feature_flags.enabled = false
  and channel_feature_flags.enabled_by_user_id is null
  and channel_feature_flags.enabled_at is null;

-- New and reconnected active channels receive the safe default once. ON CONFLICT DO
-- NOTHING is intentional: a later administrator rollback must never be auto-reenabled.
create or replace function aurora_provision_today_feature()
returns trigger language plpgsql as $$
begin
  if new.is_active = true and new.status = 'active' then
    insert into channel_feature_flags (
      project_id,
      channel_id,
      feature_key,
      enabled,
      enabled_at
    ) values (
      new.project_id,
      new.id,
      'content_intelligence_release_1',
      true,
      now()
    ) on conflict (project_id, channel_id, feature_key) do nothing;
  end if;
  return new;
end
$$;

drop trigger if exists channels_provision_today_feature_after_write on channels;
create trigger channels_provision_today_feature_after_write
  after insert or update of is_active, status, project_id on channels
  for each row execute function aurora_provision_today_feature();

-- Source attempts are an additive read model. A failed refresh updates only its safe
-- status and keeps last_success_at, so transient provider errors never erase good data.
create table if not exists today_source_refreshes (
  project_id bigint not null references projects (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  source text not null,
  last_attempt_state text,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_code varchar(96),
  updated_at timestamptz not null default now(),
  primary key (project_id, channel_id, source),
  constraint today_source_refreshes_channel_project_fk
    foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade,
  constraint today_source_refreshes_source_check
    check (source in ('reviews', 'opportunities', 'results')),
  constraint today_source_refreshes_state_check
    check (last_attempt_state is null or last_attempt_state in ('success', 'error')),
  constraint today_source_refreshes_error_check
    check (
      (last_attempt_state = 'error' and last_error_code is not null)
      or (last_attempt_state is distinct from 'error' and last_error_code is null)
    )
);

create index if not exists today_source_refreshes_health_idx
  on today_source_refreshes (project_id, channel_id, last_attempt_state, last_success_at desc);

insert into today_source_refreshes (project_id, channel_id, source)
select channel.project_id, channel.id, source.name
  from channels channel
 cross join (values ('reviews'), ('opportunities'), ('results')) as source(name)
 where channel.is_active = true
   and channel.status = 'active'
on conflict (project_id, channel_id, source) do nothing;

commit;
