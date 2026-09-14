begin;

-- Measured last-page range query previously scanned 12,000 unrelated historical drafts.
create index if not exists drafts_project_schedule_idx
  on drafts (project_id, scheduled_at, id);

commit;
