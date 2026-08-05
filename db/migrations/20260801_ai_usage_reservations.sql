begin;

-- Legacy rows are completed usage. New paid calls start as reserved and are finalized
-- explicitly, so crashes/cancellation cannot leave an indistinguishable permanent charge.
alter table ai_usage add column if not exists status text not null default 'committed';
alter table ai_usage add column if not exists reservation_key varchar(128);
alter table ai_usage add column if not exists reserved_at timestamptz;
alter table ai_usage add column if not exists expires_at timestamptz;
alter table ai_usage add column if not exists finalized_at timestamptz;

update ai_usage
   set finalized_at = coalesce(finalized_at, created_at)
 where status = 'committed' and finalized_at is null;

alter table ai_usage drop constraint if exists ai_usage_status_check;
alter table ai_usage add constraint ai_usage_status_check
  check (status in ('reserved', 'committed', 'released', 'expired'));

alter table ai_usage drop constraint if exists ai_usage_reservation_fields_check;
alter table ai_usage add constraint ai_usage_reservation_fields_check check (
  status <> 'reserved'
  or (reservation_key is not null and reserved_at is not null and expires_at is not null)
);

create unique index if not exists ai_usage_user_reservation_key_uniq
  on ai_usage (user_id, reservation_key)
  where reservation_key is not null;

create index if not exists ai_usage_active_user_date_idx
  on ai_usage (user_id, usage_date, status);

create index if not exists ai_usage_reserved_expiry_idx
  on ai_usage (expires_at, id)
  where status = 'reserved';

commit;
