begin;

-- Onboarding is account-level, but every saved artifact is scoped to the selected
-- server-owned project. Composite foreign keys prevent a channel or draft from a
-- different project being attached to the progress record.
create table if not exists onboarding_progress (
  user_id              bigint primary key references users (id) on delete cascade,
  project_id           bigint not null,
  step                 smallint not null default 1,
  channel_id           bigint,
  first_draft_id       bigint,
  skipped_first_source boolean not null default false,
  version              bigint not null default 1,
  completed_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint onboarding_progress_member_fk
    foreign key (project_id, user_id)
    references project_members (project_id, user_id) on delete cascade,
  constraint onboarding_progress_channel_project_fk
    foreign key (channel_id, project_id)
    references channels (id, project_id) on delete restrict,
  constraint onboarding_progress_draft_project_fk
    foreign key (first_draft_id, project_id)
    references drafts (id, project_id) on delete restrict,
  constraint onboarding_progress_step_check check (step between 1 and 5),
  constraint onboarding_progress_version_check check (version > 0),
  constraint onboarding_progress_completion_check check (
    completed_at is null
    or (step = 5 and channel_id is not null and first_draft_id is not null)
  )
);

create index if not exists onboarding_progress_project_updated_idx
  on onboarding_progress (project_id, updated_at desc);

commit;
