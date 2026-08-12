begin;

-- A browser-origin header is not proof that a project controls a domain. Existing
-- active rows are deliberately demoted until the server reads the exact challenge
-- from the configured site's well-known path.
alter table project_tracking_settings
  add column if not exists verification_challenge varchar(160),
  add column if not exists signal_received_at timestamptz,
  add column if not exists verification_checked_at timestamptz,
  add column if not exists verification_error_code varchar(100);

-- The legacy status constraint does not know pending_verification, so replace the
-- four tracking checks before demoting rows inside this same transaction.
alter table project_tracking_settings
  drop constraint if exists project_tracking_settings_status_check,
  drop constraint if exists project_tracking_settings_readiness_check,
  drop constraint if exists project_tracking_settings_challenge_check,
  drop constraint if exists project_tracking_settings_verification_error_check;

update project_tracking_settings
   set verification_challenge = 'aurora-site-verification='
       || replace(gen_random_uuid()::text, '-', '')
       || replace(gen_random_uuid()::text, '-', ''),
       status = case when status = 'active' then 'pending_verification' else status end,
       verified_at = case when status = 'active' then null else verified_at end,
       verification_error_code = case when status = 'active' then 'verification_required' else verification_error_code end,
       updated_at = now()
 where site_origin is not null
   and public_key is not null
   and verification_challenge is null;

alter table project_tracking_settings
  add constraint project_tracking_settings_status_check
    check (status in ('not_connected','pending_verification','active','paused','verification_failed')),
  add constraint project_tracking_settings_challenge_check check (
    verification_challenge is null
    or verification_challenge ~ '^aurora-site-verification=[A-Za-z0-9_-]{32,128}$'
  ),
  add constraint project_tracking_settings_verification_error_check check (
    verification_error_code is null
    or verification_error_code ~ '^[a-z0-9_]{1,100}$'
  ),
  add constraint project_tracking_settings_readiness_check check (
    (
      status = 'active'
      and site_origin is not null
      and public_key is not null
      and verification_challenge is not null
      and verified_at is not null
      and verification_checked_at is not null
      and verification_error_code is null
    )
    or status <> 'active'
  );

create table if not exists legal_visual_render_attempts (
  id             bigint generated always as identity primary key,
  project_id     bigint not null references projects (id) on delete cascade,
  operation_id   bigint not null,
  attempt_number integer not null,
  status         text not null,
  safe_error_code varchar(100),
  started_at     timestamptz not null default now(),
  completed_at   timestamptz,
  constraint legal_visual_render_attempts_operation_project_fk
    foreign key (operation_id, project_id)
    references legal_visual_render_operations (id, project_id) on delete cascade,
  constraint legal_visual_render_attempts_number_check check (attempt_number > 0),
  constraint legal_visual_render_attempts_status_check
    check (status in ('running','succeeded','failed_retry','failed')),
  constraint legal_visual_render_attempts_error_check
    check (safe_error_code is null or safe_error_code ~ '^[a-z0-9_]{1,100}$'),
  constraint legal_visual_render_attempts_completion_check check (
    (status = 'running' and completed_at is null)
    or (status <> 'running' and completed_at is not null)
  ),
  unique (operation_id, attempt_number)
);
create index if not exists legal_visual_render_attempts_project_operation_idx
  on legal_visual_render_attempts (project_id, operation_id, attempt_number);

create table if not exists publication_extra_attempts (
  id             bigint generated always as identity primary key,
  project_id     bigint not null references projects (id) on delete cascade,
  operation_id   bigint not null,
  attempt_number integer not null,
  status         text not null,
  safe_error_code varchar(100),
  started_at     timestamptz not null default now(),
  completed_at   timestamptz,
  constraint publication_extra_attempts_operation_project_fk
    foreign key (operation_id, project_id)
    references publication_extra_operations (id, project_id) on delete cascade,
  constraint publication_extra_attempts_number_check check (attempt_number > 0),
  constraint publication_extra_attempts_status_check
    check (status in ('running','succeeded','failed_retry','failed')),
  constraint publication_extra_attempts_error_check
    check (safe_error_code is null or safe_error_code ~ '^[a-z0-9_]{1,100}$'),
  constraint publication_extra_attempts_completion_check check (
    (status = 'running' and completed_at is null)
    or (status <> 'running' and completed_at is not null)
  ),
  unique (operation_id, attempt_number)
);
create index if not exists publication_extra_attempts_project_operation_idx
  on publication_extra_attempts (project_id, operation_id, attempt_number);

commit;
