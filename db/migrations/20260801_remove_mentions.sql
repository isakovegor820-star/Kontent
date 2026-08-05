begin;

-- The application no longer exposes the legacy mentions feature, but its historical
-- tables are intentionally preserved. Dropping customer data requires a separately
-- approved retention/export migration; this compatibility migration is therefore a no-op.
select 1;

commit;
