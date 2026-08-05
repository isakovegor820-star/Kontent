begin;

-- External delivery is not a boolean. Keep legacy rows, but classify them conservatively
-- so a local `published` flag cannot masquerade as a live external message.
alter table posts add column if not exists external_message_id text;
alter table posts add column if not exists publish_started_at timestamptz;
alter table posts add column if not exists publish_lease_token text;
alter table posts add column if not exists last_verification_attempt_at timestamptz;
alter table posts add column if not exists last_verified_at timestamptz;
alter table posts add column if not exists verification_state text not null default 'unverified';
alter table posts add column if not exists verification_result jsonb not null default '{}'::jsonb;
alter table posts add column if not exists verification_error_code text;
alter table posts add column if not exists verification_error_reason text;
alter table posts add column if not exists consecutive_missing_checks integer not null default 0;
alter table posts add column if not exists idempotency_key text;
alter table posts add column if not exists request_fingerprint text;
alter table posts add column if not exists last_retry_key text;
alter table posts add column if not exists retry_requested_at timestamptz;

alter table posts drop constraint if exists posts_status_check;
alter table posts add constraint posts_status_check check (
  status in (
    'draft', 'scheduled', 'publishing', 'published_unverified', 'published',
    'missing', 'deleted_external', 'failed'
  )
);

alter table posts drop constraint if exists posts_verification_state_check;
alter table posts add constraint posts_verification_state_check check (
  verification_state in ('unverified', 'verified', 'missing', 'unverifiable')
);

update posts
   set external_message_id = coalesce(
     external_message_id,
     tg_message_id::text,
     vk_post_id::text,
     external_post_id
   )
 where external_message_id is null;

-- Legacy `gone` is only a stale public-feed signal: the audit showed that it can describe
-- messages outside the fetched window. It is not enough evidence for `missing`; preserve
-- the row and require the new two-observation reconciler to make that transition.
update posts
   set status = 'published_unverified',
       verification_state = 'unverifiable',
       verification_result = jsonb_build_object(
         'result', 'legacy_missing_signal',
         'source', 'legacy_stats_state'
       )
 where status = 'published' and stats_state = 'gone';

-- A legacy `ok` snapshot plus an external id is evidence of a once-live message.
update posts p
   set verification_state = 'verified',
       last_verified_at = coalesce(
         (select max(s.collected_at) from post_stats s where s.post_id = p.id),
         p.published_at
       ),
       verification_result = jsonb_build_object('result', 'seen', 'source', 'legacy_stats')
 where p.status = 'published'
   and p.stats_state = 'ok'
   and p.external_message_id is not null;

-- Everything else is delivery history, not proof that the external message still exists.
update posts
   set status = 'published_unverified',
       verification_result = case
         when verification_result = '{}'::jsonb
           then jsonb_build_object('result', 'unverified_legacy')
         else verification_result
       end
 where status = 'published' and verification_state <> 'verified';

-- Old retries could leave several local rows pointing at the same external message. Keep
-- every local row, but only the strongest/most recent row may claim that destination.
-- Ambiguous duplicates become unverified history instead of making the unique index fail.
with ranked_external_ids as (
  select id,
         row_number() over (
           partition by channel_id, external_message_id
           order by (stats_state = 'ok') desc nulls last, published_at desc nulls last, id desc
         ) as external_rank
    from posts
   where external_message_id is not null
)
update posts p
   set external_message_id = null,
       status = case when p.status = 'published' then 'published_unverified' else p.status end,
       verification_state = 'unverifiable',
       verification_result = coalesce(p.verification_result, '{}'::jsonb)
         || jsonb_build_object('result', 'duplicate_legacy_external_id')
  from ranked_external_ids ranked
 where p.id = ranked.id and ranked.external_rank > 1;

create unique index if not exists posts_channel_external_message_uniq
  on posts (channel_id, external_message_id)
  where external_message_id is not null;

create unique index if not exists posts_user_idempotency_key_uniq
  on posts (user_id, idempotency_key)
  where idempotency_key is not null;

create unique index if not exists posts_user_request_fingerprint_uniq
  on posts (user_id, request_fingerprint)
  where request_fingerprint is not null;

create index if not exists posts_verified_published_idx
  on posts (channel_id, published_at desc)
  where status = 'published' and verification_state = 'verified';

commit;
