begin;

-- Completion belongs to the authenticated account, not to one browser's localStorage.
alter table users add column if not exists onboarding_completed_at timestamptz;

-- Existing installations may predate the canonical schema addition.
alter table users add column if not exists ai_post_settings jsonb not null default '{}'::jsonb;

commit;
