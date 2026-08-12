begin;

-- Migrations 20260815 and 20260816 had already been applied before these four
-- changes were developed. Keep their historical bytes immutable and apply every
-- later schema amendment here so an existing database and a fresh bootstrap
-- converge on the same contract.
alter table monthly_campaign_regeneration_targets
  add column if not exists item_regeneration_version bigint;
update monthly_campaign_regeneration_targets target
   set item_regeneration_version = item.regeneration_version
  from monthly_campaign_items item
 where item.id = target.item_id and item.project_id = target.project_id
   and target.item_regeneration_version is null;
alter table monthly_campaign_regeneration_targets
  alter column item_regeneration_version set not null;

alter table publication_review_tasks
  add column if not exists version bigint;
update publication_review_tasks
   set version = 1
 where version is null;
alter table publication_review_tasks
  alter column version set default 1;
alter table publication_review_tasks
  alter column version set not null;

alter table publication_extra_operations
  drop constraint if exists publication_extra_operations_project_id_post_id_sequence_in_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'autopilot_plan'::regclass
       and conname = 'autopilot_plan_approval_operation_project_fk'
  ) then
    alter table autopilot_plan add constraint autopilot_plan_approval_operation_project_fk
      foreign key (approval_operation_id, project_id)
      references autopilot_approval_operations (id, project_id);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_review_tasks'::regclass
       and conname = 'publication_review_tasks_version_check'
  ) then
    alter table publication_review_tasks add constraint publication_review_tasks_version_check
      check (version > 0);
  end if;
end
$$;

commit;
