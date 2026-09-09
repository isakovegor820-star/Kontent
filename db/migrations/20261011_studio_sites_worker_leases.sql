BEGIN;

-- Additive ownership fences for recoverable Studio / Sites background work.
-- Old releases ignore these nullable columns; no existing content is changed.
alter table media_generations add column if not exists worker_lease_token uuid;
alter table media_generations add column if not exists worker_heartbeat_at timestamptz;
alter table site_articles add column if not exists worker_lease_token uuid;
alter table site_articles add column if not exists worker_heartbeat_at timestamptz;
alter table site_profiles add column if not exists worker_lease_token uuid;
alter table site_profiles add column if not exists worker_heartbeat_at timestamptz;
alter table site_reports add column if not exists worker_lease_token uuid;
alter table site_reports add column if not exists worker_heartbeat_at timestamptz;
alter table site_reports add column if not exists interpretation_revision integer not null default 1;

COMMIT;
