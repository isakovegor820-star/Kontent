begin;

alter table monthly_campaign_regeneration_operations
  drop constraint if exists monthly_campaign_regeneration_scope_check;

alter table monthly_campaign_regeneration_operations
  add constraint monthly_campaign_regeneration_scope_check
  check (scope in ('item','week','month'));

alter table monthly_campaign_regeneration_operations
  drop constraint if exists monthly_campaign_regeneration_week_check;

alter table monthly_campaign_regeneration_operations
  add constraint monthly_campaign_regeneration_week_check check (
    (scope in ('item','month') and week_starts_on is null)
    or (scope = 'week' and week_starts_on is not null)
  );

commit;
