begin;

-- A running build must not change shape when the user edits channel defaults. Persist the
-- normalized frequency and final expected size beside the already-snapshotted model/horizon.
alter table autopilot_plan add column if not exists generation_post_frequency smallint;
alter table autopilot_plan add column if not exists expected_post_count smallint;

update autopilot_plan plan
   set generation_post_frequency = coalesce(
         (
           select least(30, greatest(1, settings.post_frequency))::smallint
             from autopilot_settings settings
            where settings.project_id = plan.project_id
              and settings.channel_id = plan.channel_id
            limit 1
         ),
         5
       )
 where generation_post_frequency is null;

update autopilot_plan
   set expected_post_count = least(
         90,
         greatest(1, generation_post_frequency) * greatest(1, planning_weeks)
       )::smallint
 where expected_post_count is null;

alter table autopilot_plan alter column generation_post_frequency set default 5;
alter table autopilot_plan alter column generation_post_frequency set not null;
alter table autopilot_plan alter column expected_post_count set default 5;
alter table autopilot_plan alter column expected_post_count set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'autopilot_plan'::regclass
       and conname = 'autopilot_plan_generation_post_frequency_check'
  ) then
    alter table autopilot_plan
      add constraint autopilot_plan_generation_post_frequency_check
      check (generation_post_frequency between 1 and 30);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'autopilot_plan'::regclass
       and conname = 'autopilot_plan_expected_post_count_check'
  ) then
    alter table autopilot_plan
      add constraint autopilot_plan_expected_post_count_check
      check (expected_post_count between 1 and 90);
  end if;
end
$$;

commit;
