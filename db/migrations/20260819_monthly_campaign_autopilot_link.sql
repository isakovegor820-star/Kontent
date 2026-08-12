begin;

-- An Autopilot week may be materialized from one approved monthly plan. The selected
-- project is part of the FK, so a queued job cannot attach another tenant's campaign.
alter table autopilot_plan
  add column if not exists monthly_campaign_plan_id bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'autopilot_plan_monthly_campaign_project_fk'
  ) then
    alter table autopilot_plan
      add constraint autopilot_plan_monthly_campaign_project_fk
      foreign key (monthly_campaign_plan_id, project_id)
      references monthly_campaign_plans (id, project_id)
      on delete restrict;
  end if;
end
$$;

create index if not exists autopilot_plan_monthly_campaign_idx
  on autopilot_plan (project_id, monthly_campaign_plan_id, created_at desc, id desc)
  where monthly_campaign_plan_id is not null;

commit;
