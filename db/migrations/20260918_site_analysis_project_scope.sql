begin;

alter table site_analysis_jobs
  add column if not exists project_id bigint references projects (id) on delete restrict;

-- A legacy analysis can be assigned only when the creator has exactly one active,
-- non-archived project. Collaborative users are intentionally left unassigned: choosing
-- one of several projects would disclose the analysis to the wrong tenant.
with unambiguous_membership as (
  select member.user_id, min(member.project_id) as project_id
    from project_members member
    join projects project on project.id = member.project_id and project.is_archived = false
   where member.status = 'active'
   group by member.user_id
  having count(*) = 1
)
update site_analysis_jobs job
   set project_id = membership.project_id
  from unambiguous_membership membership
 where job.project_id is null and membership.user_id = job.user_id;

create index if not exists site_analysis_jobs_project_created_idx
  on site_analysis_jobs (project_id, created_at desc, id desc)
  where project_id is not null;

create unique index if not exists site_analysis_jobs_project_user_idempotency_uniq
  on site_analysis_jobs (project_id, user_id, idempotency_key)
  where project_id is not null;

commit;
