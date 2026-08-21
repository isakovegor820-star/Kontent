begin;

-- Publication targets remain the user-facing scheduling contract. Candidate counts and
-- candidate payloads are build-only state: reserve drafts never enter approval or the
-- publication outbox unless the deterministic selector places them in `items`.
alter table autopilot_plan
  add column if not exists publication_target_count smallint,
  add column if not exists candidate_count smallint,
  add column if not exists candidate_items jsonb;

alter table autopilot_plan add constraint autopilot_plan_publication_target_count_check
  check (publication_target_count is null or publication_target_count between 1 and 90);
alter table autopilot_plan add constraint autopilot_plan_candidate_count_check
  check (candidate_count is null or candidate_count between 1 and 126);
alter table autopilot_plan add constraint autopilot_plan_candidate_target_check
  check (
    candidate_count is null
    or publication_target_count is null
    or candidate_count >= publication_target_count
  );
alter table autopilot_plan add constraint autopilot_plan_candidate_items_check
  check (candidate_items is null or jsonb_typeof(candidate_items) = 'array');

commit;
