begin;

alter table saved_posts
  add column if not exists channel_id bigint references channels (id) on delete cascade;

alter table hashtag_sets
  add column if not exists channel_id bigint references channels (id) on delete cascade;

-- Старые записи были account-wide, поэтому их исходный channel нельзя вывести
-- достоверно. Оставляем их unassigned (NULL), не подмешивая в первый бренд аккаунта.
-- Явное назначение можно сделать позднее отдельным пользовательским действием.

create index if not exists saved_posts_channel_idx
  on saved_posts (user_id, channel_id, created_at desc);

alter table hashtag_sets drop constraint if exists hashtag_sets_user_id_name_key;
create unique index if not exists hashtag_sets_channel_name_uniq
  on hashtag_sets (user_id, channel_id, name);
create unique index if not exists hashtag_sets_unassigned_name_uniq
  on hashtag_sets (user_id, name) where channel_id is null;

commit;
