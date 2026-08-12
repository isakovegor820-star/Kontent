begin;

-- A confirmed stats snapshot must become visible from the monthly plan regardless
-- of which provider collector wrote it. The existing composite foreign key keeps
-- the link inside one post and project; this trigger only advances to the newest
-- snapshot and never rewrites campaign content.
create or replace function aurora_link_monthly_campaign_post_stats()
returns trigger
language plpgsql
as $$
begin
  update monthly_campaign_items item
     set latest_post_stats_id = new.id,
         updated_at = now()
   where item.project_id = new.project_id
     and item.post_id = new.post_id
     and (
       item.latest_post_stats_id is null
       or exists (
         select 1
           from post_stats previous
          where previous.id = item.latest_post_stats_id
            and (previous.snapshot_date, previous.id) < (new.snapshot_date, new.id)
       )
     );
  return new;
end
$$;

drop trigger if exists post_stats_link_monthly_campaign_after_write on post_stats;
create trigger post_stats_link_monthly_campaign_after_write
  after insert or update of views, reactions, reposts, comments, collected_at
  on post_stats
  for each row
  execute function aurora_link_monthly_campaign_post_stats();

-- Bring already collected snapshots into the same invariant without deleting or
-- changing historical statistics.
with latest as (
  select distinct on (stats.project_id, stats.post_id)
         stats.project_id, stats.post_id, stats.id
    from post_stats stats
   order by stats.project_id, stats.post_id, stats.snapshot_date desc, stats.id desc
)
update monthly_campaign_items item
   set latest_post_stats_id = latest.id,
       updated_at = now()
  from latest
 where item.project_id = latest.project_id
   and item.post_id = latest.post_id
   and item.latest_post_stats_id is distinct from latest.id;

commit;
