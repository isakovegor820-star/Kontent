begin;

-- Some accepted legacy installations predate durable generated-media storage. Create the
-- last PostgreSQL-only shape before the later object-storage migration adds its metadata.
create table if not exists media_assets (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  kind text not null check (kind in ('image','video')),
  file_name text not null,
  mime_type text not null,
  bytes int not null,
  data bytea not null,
  sha256 text not null,
  duration_seconds int,
  created_at timestamptz not null default now()
);
create index if not exists media_assets_user_idx on media_assets (user_id, created_at desc);

commit;
