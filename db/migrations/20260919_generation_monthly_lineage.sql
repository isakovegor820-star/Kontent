begin;

-- Optional server-owned identity for generations started from a monthly campaign item.
-- All legacy/non-monthly generation operations remain valid and older releases can keep
-- inserting NULLs while the new release rolls out.
alter table generation_operations
  add column if not exists monthly_campaign_id bigint,
  add column if not exists monthly_plan_id bigint,
  add column if not exists monthly_item_id bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'generation_operations'::regclass
       and conname = 'generation_operations_monthly_lineage_complete_check'
  ) then
    alter table generation_operations
      add constraint generation_operations_monthly_lineage_complete_check
      check (
        (monthly_campaign_id is null and monthly_plan_id is null and monthly_item_id is null)
        or
        (monthly_campaign_id is not null and monthly_plan_id is not null and monthly_item_id is not null)
      );
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'generation_operations'::regclass
      and conname = 'generation_operations_monthly_campaign_fk'
  ) then
    alter table generation_operations add constraint generation_operations_monthly_campaign_fk
      foreign key (monthly_campaign_id) references monthly_campaigns (id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'generation_operations'::regclass
      and conname = 'generation_operations_monthly_plan_fk'
  ) then
    alter table generation_operations add constraint generation_operations_monthly_plan_fk
      foreign key (monthly_plan_id) references monthly_campaign_plans (id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'generation_operations'::regclass
      and conname = 'generation_operations_monthly_item_fk'
  ) then
    alter table generation_operations add constraint generation_operations_monthly_item_fk
      foreign key (monthly_item_id) references monthly_campaign_items (id) on delete restrict;
  end if;
end
$$;

create index if not exists generation_operations_monthly_lineage_idx
  on generation_operations (monthly_item_id, channel_id, id)
  where monthly_item_id is not null;

commit;
