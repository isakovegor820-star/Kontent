begin;

-- Continuation semantics for Autopilot scheduling. A new build used to delete every
-- scheduled post of the previous pending/approved plan the moment it finished — before
-- the user ever saw the new plan. `schedule_mode` records the user's explicit choice:
-- 'continue' keeps existing scheduled posts and places the new plan after their
-- coverage; 'replace' keeps the old destructive behavior. `coverage_until` is the end
-- of the already-planned window captured when the build was started, so the worker
-- shifts slots deterministically without re-reading the calendar mid-generation.
alter table autopilot_plan
  add column if not exists schedule_mode text,
  add column if not exists coverage_until timestamptz;

alter table autopilot_plan add constraint autopilot_plan_schedule_mode_check
  check (schedule_mode is null or schedule_mode in ('continue', 'replace'));

commit;
