begin;

-- Legacy publication operations cannot be tied to an immutable editorial approval
-- reliably. Keep the new lineage nullable for those rows, while requiring every new
-- approved publication to carry one complete, project-scoped revision identity.
alter table publication_operations
  add column if not exists approved_revision_id bigint;
alter table publication_operations
  add column if not exists approved_draft_version bigint;
alter table publication_operations
  add column if not exists approved_content_hash char(64);

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'publication_operations'::regclass
       and conname = 'publication_operations_approved_lineage_check'
  ) then
    alter table publication_operations
      add constraint publication_operations_approved_lineage_check
      check (
        (
          approved_revision_id is null
          and approved_draft_version is null
          and approved_content_hash is null
        )
        or (
          approved_revision_id is not null
          and draft_id is not null
          and approved_draft_version is not null
          and approved_draft_version = draft_version
          and approved_content_hash is not null
        )
      );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'publication_operations'::regclass
       and conname = 'publication_operations_approved_content_hash_check'
  ) then
    alter table publication_operations
      add constraint publication_operations_approved_content_hash_check
      check (
        approved_content_hash is null
        or approved_content_hash ~ '^[0-9a-f]{64}$'
      );
  end if;
end
$$;

-- PostgreSQL requires an exact unique key for the wider approval foreign key.
-- Including the globally unique revision id makes this additive and duplicate-safe.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'draft_revisions'::regclass
       and conname = 'draft_revisions_approval_lineage_uniq'
  ) then
    alter table draft_revisions
      add constraint draft_revisions_approval_lineage_uniq
      unique (id, project_id, draft_id, draft_version, content_hash);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'publication_operations'::regclass
       and conname = 'publication_operations_approved_revision_fk'
  ) then
    alter table publication_operations
      add constraint publication_operations_approved_revision_fk
      foreign key (
        approved_revision_id,
        project_id,
        draft_id,
        approved_draft_version,
        approved_content_hash
      )
      references draft_revisions (
        id,
        project_id,
        draft_id,
        draft_version,
        content_hash
      )
      on delete restrict;
  end if;
end
$$;

-- Fail closed if a partially managed database already contains conflicting
-- approved lineages. Never delete or rewrite publication history automatically.
do $$
declare
  duplicate_lineage record;
begin
  select project_id, draft_id, approved_revision_id, count(*) as operation_count
    into duplicate_lineage
    from publication_operations
   where approved_revision_id is not null
   group by project_id, draft_id, approved_revision_id
  having count(*) > 1
   limit 1;

  if found then
    raise exception
      'publication_approved_revision_duplicate: project_id=%, draft_id=%, approved_revision_id=%, count=%',
      duplicate_lineage.project_id,
      duplicate_lineage.draft_id,
      duplicate_lineage.approved_revision_id,
      duplicate_lineage.operation_count
      using errcode = '23505';
  end if;
end
$$;

create unique index if not exists publication_operations_approved_revision_uniq
  on publication_operations (project_id, draft_id, approved_revision_id)
  where approved_revision_id is not null;

commit;
