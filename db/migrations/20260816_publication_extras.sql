begin;

-- Project-owned reusable text fragments. Rows are versioned in place; immutable
-- publication snapshots keep the exact text/version used for a scheduled post.
create table if not exists project_publication_blocks (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  kind               text not null,
  name               varchar(120) not null,
  body               text not null,
  version            bigint not null default 1,
  is_enabled         boolean not null default true,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint project_publication_blocks_kind_check check (
    kind in ('author_signature','contacts','disclaimer','cta','sources','first_comment')
  ),
  constraint project_publication_blocks_name_check check (length(btrim(name)) between 1 and 120),
  constraint project_publication_blocks_body_check check (length(btrim(body)) between 1 and 2000),
  constraint project_publication_blocks_version_check check (version > 0),
  unique (id, project_id)
);
create index if not exists project_publication_blocks_project_kind_idx
  on project_publication_blocks (project_id, kind, is_enabled desc, id);

-- Per-draft choices stay editable until scheduling. The publication operation copies
-- their exact rendered snapshot into its immutable options JSON.
create table if not exists draft_publication_preferences (
  draft_id                    bigint primary key,
  project_id                  bigint not null references projects (id) on delete cascade,
  selected_block_ids          jsonb not null default '[]'::jsonb,
  first_comment_fallback      text not null default 'skip',
  comments_mode               text not null default 'provider_default',
  pin_after_publish           boolean not null default false,
  review_at                   timestamptz,
  review_responsible_user_id  bigint references users (id) on delete set null,
  version                     bigint not null default 1,
  updated_by_user_id          bigint not null references users (id) on delete restrict,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint draft_publication_preferences_draft_project_fk foreign key (draft_id, project_id)
    references drafts (id, project_id) on delete cascade,
  constraint draft_publication_preferences_blocks_check check (jsonb_typeof(selected_block_ids) = 'array'),
  constraint draft_publication_preferences_fallback_check check (
    first_comment_fallback in ('append_to_post','skip')
  ),
  constraint draft_publication_preferences_comments_check check (
    comments_mode in ('provider_default','enabled','disabled')
  ),
  constraint draft_publication_preferences_review_check check (
    (review_at is null and review_responsible_user_id is null)
    or (review_at is not null and review_responsible_user_id is not null)
  ),
  constraint draft_publication_preferences_version_check check (version > 0),
  unique (draft_id, project_id)
);
create index if not exists draft_publication_preferences_project_review_idx
  on draft_publication_preferences (project_id, review_at, draft_id)
  where review_at is not null;

-- Additional provider actions are independent from the main post: a failed comment,
-- pin or comment-mode request never downgrades a confirmed publication.
create table if not exists publication_extra_operations (
  id                       bigint generated always as identity primary key,
  project_id               bigint not null references projects (id) on delete cascade,
  publication_operation_id bigint references publication_operations (id) on delete cascade,
  post_id                  bigint not null,
  channel_id               bigint not null,
  kind                     text not null,
  sequence_index           smallint not null,
  idempotency_key          varchar(160) not null,
  fingerprint              char(64) not null,
  request_snapshot         jsonb not null,
  status                   text not null default 'pending',
  external_id              text,
  external_url             text,
  attempts                 integer not null default 0,
  next_attempt_at          timestamptz not null default now(),
  last_error_code          text,
  last_error_message       text,
  lease_token              char(64),
  lease_expires_at         timestamptz,
  provider_started_at      timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint publication_extra_operations_post_project_fk foreign key (post_id, project_id)
    references posts (id, project_id) on delete cascade,
  constraint publication_extra_operations_channel_project_fk foreign key (channel_id, project_id)
    references channels (id, project_id) on delete cascade,
  constraint publication_extra_operations_operation_project_fk
    foreign key (publication_operation_id, project_id)
    references publication_operations (id, project_id) on delete cascade,
  constraint publication_extra_operations_kind_check check (
    kind in ('first_comment','configure_comments','pin','unpin')
  ),
  constraint publication_extra_operations_sequence_check check (sequence_index between 1 and 100),
  constraint publication_extra_operations_fingerprint_check check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint publication_extra_operations_snapshot_check check (jsonb_typeof(request_snapshot) = 'object'),
  constraint publication_extra_operations_status_check check (
    status in ('pending','dispatching','queued','running','waiting_dependency',
               'succeeded','failed_retry','failed','skipped','unsupported','cancelled')
  ),
  constraint publication_extra_operations_attempts_check check (attempts >= 0),
  constraint publication_extra_operations_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  unique (project_id, idempotency_key),
  unique (project_id, post_id, sequence_index),
  unique (id, project_id)
);
create index if not exists publication_extra_operations_post_idx
  on publication_extra_operations (project_id, post_id, kind, id);
create index if not exists publication_extra_operations_due_idx
  on publication_extra_operations (next_attempt_at, id)
  where status in ('pending','failed_retry','waiting_dependency');

create table if not exists publication_extra_outbox (
  id                bigint generated always as identity primary key,
  project_id        bigint not null references projects (id) on delete cascade,
  operation_id      bigint not null,
  status            text not null default 'pending',
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  last_error_code   text,
  lease_token       char(64),
  lease_expires_at  timestamptz,
  enqueued_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint publication_extra_outbox_operation_project_fk foreign key (operation_id, project_id)
    references publication_extra_operations (id, project_id) on delete cascade,
  constraint publication_extra_outbox_status_check check (
    status in ('pending','dispatching','enqueued','failed','completed','cancelled')
  ),
  constraint publication_extra_outbox_attempts_check check (attempts >= 0),
  constraint publication_extra_outbox_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  unique (project_id, operation_id)
);
create index if not exists publication_extra_outbox_due_idx
  on publication_extra_outbox (next_attempt_at, id)
  where status in ('pending','failed');

-- Telegram emits the discussion copy as an automatic-forward update. Keeping the
-- verified mapping lets a later first-comment job reply to the correct thread without
-- browser automation or an undocumented API.
create table if not exists telegram_discussion_messages (
  id                    bigint generated always as identity primary key,
  project_id            bigint not null references projects (id) on delete cascade,
  channel_id            bigint not null,
  post_id               bigint,
  origin_chat_id        bigint not null,
  origin_message_id     bigint not null,
  discussion_chat_id    bigint not null,
  discussion_message_id bigint not null,
  observed_at           timestamptz not null default now(),
  constraint telegram_discussion_messages_channel_project_fk foreign key (channel_id, project_id)
    references channels (id, project_id) on delete cascade,
  constraint telegram_discussion_messages_post_project_fk foreign key (post_id, project_id)
    references posts (id, project_id) on delete cascade,
  unique (channel_id, origin_message_id),
  unique (discussion_chat_id, discussion_message_id)
);
create index if not exists telegram_discussion_messages_post_idx
  on telegram_discussion_messages (project_id, post_id)
  where post_id is not null;

create table if not exists publication_review_tasks (
  id                    bigint generated always as identity primary key,
  project_id            bigint not null references projects (id) on delete cascade,
  post_id               bigint not null,
  responsible_user_id   bigint not null references users (id) on delete restrict,
  review_at             timestamptz not null,
  timezone              varchar(80) not null,
  status                text not null default 'scheduled',
  decision              text,
  decision_note         text,
  decided_by_user_id    bigint references users (id) on delete set null,
  decided_at            timestamptz,
  reminder_idempotency_key varchar(160) not null,
  reminder_status       text not null default 'pending',
  reminder_sent_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint publication_review_tasks_post_project_fk foreign key (post_id, project_id)
    references posts (id, project_id) on delete cascade,
  constraint publication_review_tasks_timezone_check check (length(btrim(timezone)) between 1 and 80),
  constraint publication_review_tasks_status_check check (status in ('scheduled','due','completed','cancelled')),
  constraint publication_review_tasks_decision_check check (
    decision is null or decision in ('keep','update','unpin','remove_manually')
  ),
  constraint publication_review_tasks_resolution_check check (
    (status in ('scheduled','due') and decision is null and decided_by_user_id is null and decided_at is null)
    or (status = 'completed' and decision is not null and decided_by_user_id is not null and decided_at is not null)
    or (status = 'cancelled' and decision is null and decided_by_user_id is null and decided_at is null)
  ),
  constraint publication_review_tasks_reminder_status_check check (
    reminder_status in ('pending','sending','sent','failed','cancelled')
  ),
  unique (project_id, reminder_idempotency_key),
  unique (id, project_id)
);
create index if not exists publication_review_tasks_due_idx
  on publication_review_tasks (review_at, id)
  where status = 'scheduled';
create index if not exists publication_review_tasks_assignee_idx
  on publication_review_tasks (project_id, responsible_user_id, status, review_at);

commit;
