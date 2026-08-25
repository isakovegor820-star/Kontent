begin;

-- Autopilot settings are shared project state. The legacy user/channel primary key
-- overlaps the project/channel unique index and can win a concurrent uniqueness race,
-- leaking a 23505 even when ON CONFLICT targets the project key.
do $$
begin
  if exists (
    select 1 from autopilot_settings
     where project_id is null or channel_id is null
  ) then
    raise exception 'autopilot_settings_project_key_missing';
  end if;

  if exists (
    select 1
      from autopilot_settings
     group by project_id, channel_id
    having count(*) > 1
  ) then
    raise exception 'autopilot_settings_project_key_duplicate';
  end if;
end
$$;

create unique index if not exists autopilot_settings_project_channel_uniq
  on autopilot_settings (project_id, channel_id);

-- Keep the previous release's ON CONFLICT (user_id, channel_id) arbiter during a
-- forward-schema/application rollback. New code uses untargeted DO NOTHING for the
-- initial ensure, so either the legacy or project identity can safely win a race.
create unique index if not exists autopilot_settings_user_channel_uniq
  on autopilot_settings (user_id, channel_id);

do $$
begin
  if exists (
    select 1
      from pg_constraint
     where conrelid = 'autopilot_settings'::regclass
       and conname = 'autopilot_settings_pkey'
       and pg_get_constraintdef(oid) <> 'PRIMARY KEY (project_id, channel_id)'
  ) then
    alter table autopilot_settings drop constraint if exists autopilot_settings_pkey;
  end if;

  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'autopilot_settings'::regclass
       and contype = 'p'
       and pg_get_constraintdef(oid) = 'PRIMARY KEY (project_id, channel_id)'
  ) then
    alter table autopilot_settings
      add constraint autopilot_settings_pkey
      primary key using index autopilot_settings_project_channel_uniq;
  end if;
end
$$;

commit;
