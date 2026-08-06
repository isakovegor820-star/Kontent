begin;

-- Activity in the pre-add summary is derived only from public Telegram timestamps.
alter table competitor_suggestions
  add column if not exists last_post_at timestamptz;
alter table competitor_suggestions
  add column if not exists posts_per_week numeric(6,1);

commit;
