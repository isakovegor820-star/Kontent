begin;

alter table media_assets add column if not exists storage_backend text not null default 'postgres';
alter table media_assets add column if not exists object_key text;
alter table media_assets add column if not exists object_etag text;
alter table media_assets alter column data drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conrelid = 'media_assets'::regclass
      and conname = 'media_assets_storage_backend_check'
  ) then
    alter table media_assets add constraint media_assets_storage_backend_check
      check (storage_backend in ('postgres','object'));
  end if;
  if not exists (
    select 1 from pg_constraint where conrelid = 'media_assets'::regclass
      and conname = 'media_assets_storage_payload_check'
  ) then
    alter table media_assets add constraint media_assets_storage_payload_check check (
      (storage_backend = 'postgres' and data is not null and object_key is null)
      or (storage_backend = 'object' and data is null and object_key is not null)
    );
  end if;
end $$;

create unique index if not exists media_assets_object_key_uniq
  on media_assets (object_key) where object_key is not null;

create table if not exists media_object_orphans (
  id bigint generated always as identity primary key,
  object_key text not null unique,
  reason_code text not null,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists media_object_orphans_due_idx
  on media_object_orphans (next_attempt_at, id) where deleted_at is null;

create or replace function queue_deleted_media_object() returns trigger language plpgsql as $$
begin
  if old.storage_backend = 'object' and old.object_key is not null then
    insert into media_object_orphans (object_key, reason_code)
    values (old.object_key, 'asset_deleted')
    on conflict (object_key) do update
      set reason_code = excluded.reason_code, next_attempt_at = now(), deleted_at = null;
  end if;
  return old;
end $$;
drop trigger if exists media_assets_queue_object_delete on media_assets;
create trigger media_assets_queue_object_delete
  after delete on media_assets for each row execute function queue_deleted_media_object();

commit;
