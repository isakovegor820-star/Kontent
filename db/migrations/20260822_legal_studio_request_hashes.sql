begin;

-- Existing rows predate request fingerprinting and remain readable. Services replay
-- a legacy key only when the persisted identity proves equivalence; otherwise they
-- fail closed with an idempotency conflict.
alter table legal_visual_designs
  add column if not exists request_hash char(64);
alter table legal_video_scripts
  add column if not exists request_hash char(64);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'legal_visual_designs'::regclass
       and conname = 'legal_visual_designs_request_hash_check'
  ) then
    alter table legal_visual_designs
      add constraint legal_visual_designs_request_hash_check
      check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'legal_video_scripts'::regclass
       and conname = 'legal_video_scripts_request_hash_check'
  ) then
    alter table legal_video_scripts
      add constraint legal_video_scripts_request_hash_check
      check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$');
  end if;
end
$$;

commit;
