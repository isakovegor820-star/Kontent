begin;

-- One opaque correlation id follows a generation through HTTP, BullMQ and NavyAI.
-- Existing rows are backfilled without changing their user-visible state.
alter table media_generations add column if not exists request_id uuid;
update media_generations set request_id = gen_random_uuid() where request_id is null;
alter table media_generations alter column request_id set default gen_random_uuid();
alter table media_generations alter column request_id set not null;

alter table media_generations add column if not exists provider_request_key varchar(128);
update media_generations
   set provider_request_key = 'aurora-media-' || request_id::text
 where provider_request_key is null;
alter table media_generations alter column provider_request_key set not null;

alter table media_generations
  add column if not exists prompt_policy_version smallint not null default 1;
alter table media_generations
  add column if not exists prompt_context jsonb not null default '{}'::jsonb;
alter table media_generations add column if not exists queue_confirmed_at timestamptz;
alter table media_generations add column if not exists provider_started_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'media_generations'::regclass
       and conname = 'media_generations_prompt_policy_version_check'
  ) then
    alter table media_generations
      add constraint media_generations_prompt_policy_version_check
      check (prompt_policy_version = 1);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'media_generations'::regclass
       and conname = 'media_generations_prompt_context_check'
  ) then
    alter table media_generations
      add constraint media_generations_prompt_context_check
      check (jsonb_typeof(prompt_context) = 'object');
  end if;
end
$$;

create unique index if not exists media_generations_request_id_uniq
  on media_generations (request_id);
create unique index if not exists media_generations_provider_request_key_uniq
  on media_generations (provider_request_key);

commit;
