-- Replace the three fixed month presets with an exact 1–12 week horizon. The old
-- planning_months columns remain as a compatibility snapshot for older deployments.

begin;

alter table autopilot_settings add column if not exists planning_weeks smallint;
update autopilot_settings
   set planning_weeks = least(12, greatest(1, planning_months * 4))
 where planning_weeks is null;
alter table autopilot_settings alter column planning_weeks set default 4;
alter table autopilot_settings alter column planning_weeks set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'autopilot_settings'::regclass
       and conname = 'autopilot_settings_planning_weeks_check'
  ) then
    alter table autopilot_settings
      add constraint autopilot_settings_planning_weeks_check
      check (planning_weeks between 1 and 12);
  end if;
end
$$;

alter table autopilot_plan add column if not exists planning_weeks smallint;
update autopilot_plan
   set planning_weeks = least(12, greatest(1, planning_months * 4))
 where planning_weeks is null;
alter table autopilot_plan alter column planning_weeks set default 4;
alter table autopilot_plan alter column planning_weeks set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'autopilot_plan'::regclass
       and conname = 'autopilot_plan_planning_weeks_check'
  ) then
    alter table autopilot_plan
      add constraint autopilot_plan_planning_weeks_check
      check (planning_weeks between 1 and 12);
  end if;
end
$$;

commit;
