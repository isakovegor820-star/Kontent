begin;

-- P0 weekly Growth loop. The move remains the stable weekly recommendation while
-- lifecycle truth comes from a real draft or Autopilot plan through project-scoped FKs.
alter table growth_moves add column if not exists rank_position smallint;
alter table growth_moves add column if not exists evidence jsonb not null default '{}'::jsonb;
alter table growth_moves add column if not exists artifact_draft_id bigint;
alter table growth_moves add column if not exists artifact_autopilot_plan_id bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'growth_moves_rank_position_check'
  ) then
    alter table growth_moves add constraint growth_moves_rank_position_check
      check (rank_position is null or rank_position between 1 and 3);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'growth_moves_evidence_object_check'
  ) then
    alter table growth_moves add constraint growth_moves_evidence_object_check
      check (jsonb_typeof(evidence) = 'object');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'growth_moves_single_artifact_check'
  ) then
    alter table growth_moves add constraint growth_moves_single_artifact_check
      check (num_nonnulls(artifact_draft_id, artifact_autopilot_plan_id) <= 1);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'growth_moves_artifact_draft_project_fk'
  ) then
    alter table growth_moves add constraint growth_moves_artifact_draft_project_fk
      foreign key (artifact_draft_id, project_id)
      references drafts (id, project_id) on delete set null (artifact_draft_id);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'growth_moves_artifact_plan_project_fk'
  ) then
    alter table growth_moves add constraint growth_moves_artifact_plan_project_fk
      foreign key (artifact_autopilot_plan_id, project_id)
      references autopilot_plan (id, project_id) on delete set null (artifact_autopilot_plan_id);
  end if;
end
$$;

create index if not exists growth_moves_draft_artifact_idx
  on growth_moves (artifact_draft_id) where artifact_draft_id is not null;
create index if not exists growth_moves_plan_artifact_idx
  on growth_moves (artifact_autopilot_plan_id) where artifact_autopilot_plan_id is not null;

commit;
