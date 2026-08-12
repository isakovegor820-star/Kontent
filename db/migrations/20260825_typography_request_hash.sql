begin;

-- Existing typography decisions predate full-intent fingerprinting. They remain
-- readable, but a legacy idempotency key cannot be replayed safely because the
-- original quote mode and selection intent were not persisted canonically.
alter table project_typography_runs
  add column if not exists request_hash char(64);

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'project_typography_runs'::regclass
       and conname = 'project_typography_runs_request_hash_check'
  ) then
    alter table project_typography_runs
      add constraint project_typography_runs_request_hash_check
      check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$');
  end if;
end
$$;

commit;
