begin;

alter table saved_posts add column if not exists kind text not null default 'own';
alter table saved_posts add column if not exists source_post_id bigint references competitor_posts (id) on delete set null;
alter table saved_posts add column if not exists source_title text;
alter table saved_posts add column if not exists source_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'saved_posts_kind_check'
  ) then
    alter table saved_posts
      add constraint saved_posts_kind_check check (kind in ('own', 'reference'));
  end if;
end $$;

-- Один и тот же пост конкурента сохраняется в коллекцию канала только один раз.
create unique index if not exists saved_posts_reference_uniq
  on saved_posts (user_id, channel_id, source_post_id)
  where source_post_id is not null;

commit;
