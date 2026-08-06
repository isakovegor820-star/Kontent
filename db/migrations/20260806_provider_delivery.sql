begin;

alter table posts add column if not exists provider_operation_id text;
alter table posts add column if not exists provider_reconciliation_state text not null default 'none';
alter table posts add column if not exists provider_reconciliation_requested_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'posts'::regclass
       and conname = 'posts_provider_reconciliation_state_check'
  ) then
    alter table posts add constraint posts_provider_reconciliation_state_check
      check (provider_reconciliation_state in ('none','pending','confirmed','unresolved','failed'));
  end if;
end $$;

create unique index if not exists posts_provider_operation_identity_uniq
  on posts (channel_id, provider_operation_id)
  where provider_operation_id is not null;

commit;
