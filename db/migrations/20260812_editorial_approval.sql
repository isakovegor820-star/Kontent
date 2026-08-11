begin;

-- Every editorial decision is attached to a server-built, immutable snapshot of
-- one draft version. Editable drafts remain the working copy; these rows are the
-- review evidence and are never updated by application code.
create table if not exists draft_revisions (
  id             bigint generated always as identity primary key,
  project_id     bigint not null references projects (id) on delete restrict,
  draft_id       bigint not null references drafts (id) on delete cascade,
  draft_version  bigint not null,
  author_user_id bigint not null references users (id) on delete restrict,
  content_hash   char(64) not null,
  snapshot       jsonb not null,
  created_at     timestamptz not null default now(),
  constraint draft_revisions_version_check check (draft_version > 0),
  constraint draft_revisions_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint draft_revisions_snapshot_check check (jsonb_typeof(snapshot) = 'object'),
  unique (draft_id, draft_version)
);
create index if not exists draft_revisions_project_draft_idx
  on draft_revisions (project_id, draft_id, draft_version desc);
create index if not exists draft_revisions_hash_idx
  on draft_revisions (project_id, draft_id, content_hash);

create table if not exists draft_editorial_workflows (
  draft_id              bigint primary key references drafts (id) on delete cascade,
  project_id            bigint not null references projects (id) on delete restrict,
  state                 text not null default 'draft',
  version               bigint not null default 1,
  current_revision_id   bigint not null references draft_revisions (id) on delete restrict,
  submitted_revision_id bigint references draft_revisions (id) on delete restrict,
  submitted_by_user_id  bigint references users (id) on delete set null,
  submitted_at          timestamptz,
  approved_revision_id  bigint references draft_revisions (id) on delete restrict,
  approved_content_hash char(64),
  updated_at             timestamptz not null default now(),
  constraint draft_editorial_workflows_state_check
    check (state in ('draft','in_review','changes_requested','approved')),
  constraint draft_editorial_workflows_version_check check (version > 0),
  constraint draft_editorial_workflows_submission_check check (
    (submitted_revision_id is null and submitted_by_user_id is null and submitted_at is null)
    or (submitted_revision_id is not null and submitted_by_user_id is not null and submitted_at is not null)
  ),
  constraint draft_editorial_workflows_approval_check check (
    (state = 'approved' and approved_revision_id is not null and approved_content_hash is not null)
    or (state <> 'approved' and approved_revision_id is null and approved_content_hash is null)
  ),
  constraint draft_editorial_workflows_hash_check
    check (approved_content_hash is null or approved_content_hash ~ '^[0-9a-f]{64}$'),
  unique (project_id, draft_id)
);
create index if not exists draft_editorial_workflows_project_state_idx
  on draft_editorial_workflows (project_id, state, updated_at desc, draft_id);

create table if not exists draft_editorial_requests (
  id                    bigint generated always as identity primary key,
  project_id            bigint not null references projects (id) on delete restrict,
  draft_id              bigint not null references drafts (id) on delete cascade,
  revision_id           bigint not null references draft_revisions (id) on delete restrict,
  content_hash          char(64) not null,
  requested_by_user_id  bigint not null references users (id) on delete restrict,
  status                text not null default 'open',
  version               bigint not null default 1,
  resolved_by_user_id   bigint references users (id) on delete set null,
  requested_at          timestamptz not null default now(),
  resolved_at           timestamptz,
  constraint draft_editorial_requests_status_check
    check (status in ('open','approved','changes_requested','superseded')),
  constraint draft_editorial_requests_version_check check (version > 0),
  constraint draft_editorial_requests_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint draft_editorial_requests_resolution_check check (
    (status = 'open' and resolved_by_user_id is null and resolved_at is null)
    or (status <> 'open' and resolved_at is not null)
  )
);
create unique index if not exists draft_editorial_requests_open_uniq
  on draft_editorial_requests (draft_id) where status = 'open';
create index if not exists draft_editorial_requests_project_status_idx
  on draft_editorial_requests (project_id, status, requested_at desc, id desc);

create table if not exists draft_editorial_comments (
  id            bigint generated always as identity primary key,
  project_id    bigint not null references projects (id) on delete restrict,
  draft_id      bigint not null references drafts (id) on delete cascade,
  revision_id   bigint not null references draft_revisions (id) on delete restrict,
  content_hash  char(64) not null,
  author_user_id bigint not null references users (id) on delete restrict,
  body          text not null,
  created_at    timestamptz not null default now(),
  constraint draft_editorial_comments_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint draft_editorial_comments_body_check check (length(btrim(body)) between 1 and 4000)
);
create index if not exists draft_editorial_comments_revision_idx
  on draft_editorial_comments (project_id, draft_id, revision_id, created_at, id);

create table if not exists draft_editorial_decisions (
  id             bigint generated always as identity primary key,
  project_id     bigint not null references projects (id) on delete restrict,
  request_id     bigint not null unique references draft_editorial_requests (id) on delete cascade,
  draft_id       bigint not null references drafts (id) on delete cascade,
  revision_id    bigint not null references draft_revisions (id) on delete restrict,
  content_hash   char(64) not null,
  actor_user_id  bigint not null references users (id) on delete restrict,
  decision       text not null,
  note           text,
  created_at     timestamptz not null default now(),
  constraint draft_editorial_decisions_decision_check check (decision in ('approve','request_changes')),
  constraint draft_editorial_decisions_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint draft_editorial_decisions_note_check check (note is null or length(note) <= 4000),
  constraint draft_editorial_decisions_changes_note_check
    check (decision = 'approve' or length(btrim(coalesce(note, ''))) > 0)
);
create index if not exists draft_editorial_decisions_project_created_idx
  on draft_editorial_decisions (project_id, created_at desc, id desc);

-- Shared in-product inbox. Payloads are deliberately restricted to non-secret
-- identifiers and presentation metadata; message/comment bodies are not copied here.
create table if not exists project_notifications (
  id                bigint generated always as identity primary key,
  project_id        bigint not null references projects (id) on delete cascade,
  recipient_user_id bigint not null references users (id) on delete cascade,
  actor_user_id     bigint references users (id) on delete set null,
  event_type        varchar(100) not null,
  entity_type       varchar(80) not null,
  entity_id         text not null,
  safe_data         jsonb not null default '{}'::jsonb,
  idempotency_key   varchar(180),
  read_at           timestamptz,
  created_at        timestamptz not null default now(),
  constraint project_notifications_event_check check (length(btrim(event_type)) between 1 and 100),
  constraint project_notifications_entity_check check (length(btrim(entity_type)) between 1 and 80),
  constraint project_notifications_safe_data_check check (jsonb_typeof(safe_data) = 'object')
);
create unique index if not exists project_notifications_idempotency_uniq
  on project_notifications (project_id, recipient_user_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists project_notifications_inbox_idx
  on project_notifications (project_id, recipient_user_id, read_at, created_at desc, id desc);

-- Revisions and decisions may be removed only through their parent draft lifecycle;
-- application attempts to rewrite accepted evidence fail closed in PostgreSQL.
create or replace function aurora_reject_editorial_evidence_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'editorial_evidence_immutable' using errcode = '55000';
end
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'draft_revisions_immutable_update') then
    create trigger draft_revisions_immutable_update
      before update on draft_revisions for each row
      execute function aurora_reject_editorial_evidence_update();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'draft_editorial_decisions_immutable_update') then
    create trigger draft_editorial_decisions_immutable_update
      before update on draft_editorial_decisions for each row
      execute function aurora_reject_editorial_evidence_update();
  end if;
end
$$;

commit;
