begin;

-- Human attribution for asynchronous provider actions. Existing operations predate
-- this field and intentionally remain nullable/readable; every new request writes it.
alter table publication_extra_operations
  add column if not exists requested_by_user_id bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_extra_operations'::regclass
       and conname = 'publication_extra_operations_requested_by_user_id_fkey'
  ) then
    alter table publication_extra_operations
      add constraint publication_extra_operations_requested_by_user_id_fkey
      foreign key (requested_by_user_id) references users (id) on delete set null;
  end if;
end
$$;

-- An "update" review decision owns exactly one editable draft. The composite key
-- makes cross-project linkage impossible and RESTRICT preserves the decision trail.
alter table publication_review_tasks
  add column if not exists update_draft_id bigint;
alter table publication_review_tasks
  add column if not exists reminder_attempts integer not null default 0;
alter table publication_review_tasks
  add column if not exists reminder_provider_started_at timestamptz;
alter table publication_review_tasks
  add column if not exists reminder_last_error_code varchar(100);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_review_tasks'::regclass
       and conname = 'publication_review_tasks_update_draft_project_fk'
  ) then
    alter table publication_review_tasks
      add constraint publication_review_tasks_update_draft_project_fk
      foreign key (update_draft_id, project_id)
      references drafts (id, project_id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_review_tasks'::regclass
       and conname = 'publication_review_tasks_reminder_attempts_check'
  ) then
    alter table publication_review_tasks
      add constraint publication_review_tasks_reminder_attempts_check
      check (reminder_attempts >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_review_tasks'::regclass
       and conname = 'publication_review_tasks_reminder_delivery_check'
  ) then
    alter table publication_review_tasks
      add constraint publication_review_tasks_reminder_delivery_check
      check (
        (reminder_status = 'sending' and reminder_provider_started_at is not null)
        or reminder_status <> 'sending'
      );
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_review_tasks'::regclass
       and conname = 'publication_review_tasks_update_draft_check'
  ) then
    alter table publication_review_tasks
      add constraint publication_review_tasks_update_draft_check
      check (
        (status = 'completed' and decision = 'update' and update_draft_id is not null)
        or (not (status = 'completed' and decision = 'update') and update_draft_id is null)
      ) not valid;
  end if;
end
$$;

create unique index if not exists publication_review_tasks_update_draft_uniq
  on publication_review_tasks (project_id, update_draft_id)
  where update_draft_id is not null;

-- PostgreSQL owns reminder delivery. Redis/BullMQ is a recoverable dispatch layer:
-- a lost queue is rebuilt from this table without duplicating the external attempt.
create table if not exists publication_review_reminder_outbox (
  id                bigint generated always as identity primary key,
  project_id        bigint not null references projects (id) on delete cascade,
  review_task_id    bigint not null,
  recipient_user_id bigint not null references users (id) on delete restrict,
  job_key           char(64) not null,
  status            text not null default 'pending',
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  last_error_code   varchar(100),
  lease_token       char(64),
  lease_expires_at  timestamptz,
  enqueued_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint publication_review_reminder_outbox_task_project_fk
    foreign key (review_task_id, project_id)
    references publication_review_tasks (id, project_id) on delete cascade,
  constraint publication_review_reminder_outbox_job_key_check
    check (job_key ~ '^[0-9a-f]{64}$'),
  constraint publication_review_reminder_outbox_status_check
    check (status in ('pending','dispatching','enqueued','running','completed','failed','cancelled')),
  constraint publication_review_reminder_outbox_attempts_check check (attempts >= 0),
  constraint publication_review_reminder_outbox_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  unique (project_id, review_task_id),
  unique (job_key)
);

create index if not exists publication_review_reminder_outbox_due_idx
  on publication_review_reminder_outbox (next_attempt_at, id)
  where status in ('pending','failed','enqueued');

commit;
