begin;

-- The suggestion card needs the channel's own public summary, not an inferred label.
-- It is collected from the same public t.me/s/ page already used for posts and stats.
alter table competitor_suggestions
  add column if not exists description text;

commit;
