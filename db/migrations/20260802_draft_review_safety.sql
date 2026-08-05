begin;

-- AI review state is durable server data. Existing AI drafts intentionally receive a
-- null validation and therefore fail closed until a fresh check or explicit review ACK.
alter table drafts
  add column if not exists review_policy_version integer not null default 1
    check (review_policy_version = 1);
alter table drafts add column if not exists ai_validation jsonb;
alter table drafts add column if not exists human_reviewed_version bigint;
alter table drafts add column if not exists human_reviewed_at timestamptz;

commit;
