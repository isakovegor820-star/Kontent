-- Durable terminal results make paid text generation replay-safe after lost stream delivery.
begin;

alter table ai_usage add column if not exists operation_id uuid;
alter table ai_usage add column if not exists request_fingerprint varchar(64);
alter table ai_usage add column if not exists result_payload jsonb;
alter table ai_usage add column if not exists result_content_type varchar(80);

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_usage_request_fingerprint_check'
  ) then
    alter table ai_usage add constraint ai_usage_request_fingerprint_check
      check (request_fingerprint is null or request_fingerprint ~ '^[a-f0-9]{64}$')
      not valid;
  end if;
end $$;
alter table ai_usage validate constraint ai_usage_request_fingerprint_check;

create unique index if not exists ai_usage_operation_id_uniq
  on ai_usage (operation_id)
  where operation_id is not null;

commit;
