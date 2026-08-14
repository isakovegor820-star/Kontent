begin;

-- Competitor sources share one provider-neutral model. `network` stays open-ended so
-- adding VK/YouTube/web later is a registry change, not another table rewrite.
alter table competitors drop constraint if exists competitors_network_check;
alter table competitors drop constraint if exists competitors_status_check;

alter table competitors add column if not exists custom_title varchar(120);
alter table competitors add column if not exists avatar_url text;
alter table competitors add column if not exists external_id text;
alter table competitors add column if not exists connection_method text;
alter table competitors add column if not exists is_active boolean not null default true;
alter table competitors add column if not exists sync_requested_at timestamptz;
alter table competitors add column if not exists sync_started_at timestamptz;

alter table competitors
  add constraint competitors_status_check
  check (status in ('pending','refreshing','ready','error','no_feed','paused')) not valid;
alter table competitors validate constraint competitors_status_check;

alter table competitor_posts alter column tg_msg_id drop not null;
alter table competitor_posts add column if not exists external_post_id text;
alter table competitor_posts add column if not exists permalink text;
alter table competitor_posts add column if not exists like_count integer;
alter table competitor_posts add column if not exists comments_count integer;
alter table competitor_posts add column if not exists thumbnail_url text;

update competitor_posts
   set external_post_id = tg_msg_id::text
 where external_post_id is null and tg_msg_id is not null;

create unique index if not exists competitor_posts_external_key
  on competitor_posts (competitor_id, external_post_id)
  where external_post_id is not null;
create index if not exists competitors_channel_active_idx
  on competitors (channel_id, is_active, network, collected_at);

commit;
