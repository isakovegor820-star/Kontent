begin;

-- A scheduled timestamp is not indefinite authorization to publish. Rows missed by more
-- than the worker grace window become explicit review work and need a new revision/date.
alter table posts add column if not exists publication_origin text not null default 'legacy';
alter table posts add column if not exists next_attempt_at timestamptz;
alter table posts add column if not exists quarantined_at timestamptz;
alter table posts add column if not exists quarantine_reason text;
alter table posts add column if not exists schedule_revision bigint not null default 1;

update posts p
   set publication_origin = case
     when exists (select 1 from autopilot_schedule_outbox o where o.post_id = p.id) then 'autopilot'
     when exists (select 1 from rss_items i where i.post_id = p.id) then 'rss'
     when p.idempotency_key like 'autopilot:%' then 'autopilot'
     when p.last_retry_key is not null then 'retry'
     else 'legacy'
   end;

alter table posts drop constraint if exists posts_publication_origin_check;
alter table posts add constraint posts_publication_origin_check check (
  publication_origin in ('manual', 'ai', 'trend', 'competitor', 'autopilot', 'rss', 'retry', 'legacy')
);
alter table posts drop constraint if exists posts_schedule_revision_check;
alter table posts add constraint posts_schedule_revision_check check (schedule_revision > 0);

alter table posts drop constraint if exists posts_status_check;
alter table posts add constraint posts_status_check check (
  status in (
    'draft', 'scheduled', 'publishing', 'published_unverified', 'published',
    'missing', 'deleted_external', 'failed_retry', 'quarantined', 'failed'
  )
);

create index if not exists posts_reconciliation_due_idx
  on posts (status, scheduled_at, next_attempt_at, id)
  where status in ('scheduled', 'failed_retry');
create index if not exists posts_quarantined_user_idx
  on posts (user_id, quarantined_at desc, id desc)
  where status = 'quarantined';

commit;
