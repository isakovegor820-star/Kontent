begin;

-- A standalone Autopilot week is a seven-day product promise. Presentation controls are
-- intentionally compact and snapshot onto the build so moving a slider cannot mutate an
-- already-running generation.
alter table autopilot_settings
  add column if not exists quick_settings jsonb not null
  default '{"newsPerWeek":3,"detail":2,"energy":2,"emoji":1}'::jsonb;
alter table autopilot_plan
  add column if not exists quick_settings jsonb not null
  default '{"newsPerWeek":3,"detail":2,"energy":2,"emoji":1}'::jsonb;

update autopilot_settings set post_frequency = 7 where post_frequency <> 7;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'autopilot_settings'::regclass
       and conname = 'autopilot_settings_quick_settings_check'
  ) then
    alter table autopilot_settings
      add constraint autopilot_settings_quick_settings_check
      check (jsonb_typeof(quick_settings) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'autopilot_plan'::regclass
       and conname = 'autopilot_plan_quick_settings_check'
  ) then
    alter table autopilot_plan
      add constraint autopilot_plan_quick_settings_check
      check (jsonb_typeof(quick_settings) = 'object');
  end if;
end
$$;

commit;
