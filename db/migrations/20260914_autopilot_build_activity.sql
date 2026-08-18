begin;

-- JSON item checkpoints describe progress, but a long provider or semantic call can be alive
-- without finishing an item. Keep a dedicated worker heartbeat as the stale-build authority.
alter table autopilot_plan add column if not exists build_activity_at timestamptz;
update autopilot_plan
   set build_activity_at = created_at
 where build_activity_at is null;
alter table autopilot_plan alter column build_activity_at set default now();
alter table autopilot_plan alter column build_activity_at set not null;

commit;
