begin;

-- Accepted legacy installations may have the original queue-only media table. Fill
-- the durable request/result contract before project-scoped media constraints use it.
-- Legacy rows were terminal failures without a persisted provider request, so neutral
-- sentinel values preserve that truth without pretending a generated artefact exists.
alter table users
  add column if not exists avatar text;
alter table post_stats
  add column if not exists reactions integer;
alter table post_stats
  add column if not exists reposts integer;
alter table post_stats
  add column if not exists comments integer;
alter table post_stats
  add column if not exists reach integer;
alter table media_generations
  add column if not exists prompt text;
alter table media_generations
  add column if not exists negative_prompt text;
alter table media_generations
  add column if not exists model text;
alter table media_generations
  add column if not exists aspect_ratio text;
alter table media_generations
  add column if not exists quality text;
alter table media_generations
  add column if not exists seconds integer;
alter table media_generations
  add column if not exists style text;
alter table media_generations
  add column if not exists niche text;
alter table media_generations
  add column if not exists tone text;
alter table media_generations
  add column if not exists provider_job_id text;
alter table media_generations
  add column if not exists output_asset_id bigint references media_assets (id) on delete set null;
alter table media_generations
  add column if not exists error_code text;
alter table media_generations
  add column if not exists error_message text;
alter table media_generations
  add column if not exists created_at timestamptz not null default now();
alter table media_generations
  add column if not exists updated_at timestamptz not null default now();
alter table media_generations
  add column if not exists completed_at timestamptz;

update media_generations
   set prompt = coalesce(prompt, '[legacy request unavailable]'),
       model = coalesce(model, 'legacy-unknown'),
       aspect_ratio = coalesce(aspect_ratio, '1:1'),
       style = coalesce(style, 'natural'),
       error_code = coalesce(error_code, 'legacy_request_unavailable'),
       completed_at = coalesce(completed_at, created_at)
 where prompt is null or model is null or aspect_ratio is null or style is null;

alter table media_generations alter column prompt set not null;
alter table media_generations alter column model set not null;
alter table media_generations alter column aspect_ratio set not null;
alter table media_generations alter column style set default 'natural';
alter table media_generations alter column style set not null;

commit;
