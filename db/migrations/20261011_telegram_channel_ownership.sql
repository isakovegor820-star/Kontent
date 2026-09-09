begin;

-- No ownership backfill: existing bindings require a read-only review first.
create table if not exists telegram_channel_connection_proofs (
  id uuid primary key,
  user_id bigint not null references users(id) on delete cascade,
  project_id bigint not null references projects(id) on delete cascade,
  actor_id bigint not null check (actor_id > 0),
  chat_id bigint check (chat_id < 0),
  source text not null check (source in ('web', 'telegram')),
  event_id bigint unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '5 minutes',
  used_at timestamptz,
  check (expires_at > created_at)
);
create index if not exists telegram_channel_connection_proofs_actor_idx
  on telegram_channel_connection_proofs(actor_id, expires_at) where used_at is null;

-- Accepted legacy installations may predate the bootstrap-only bot link table.
create table if not exists bot_links (
  code text primary key,
  user_id bigint not null references users(id) on delete cascade,
  used_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists bot_links_user_idx on bot_links(user_id);
alter table bot_links add column if not exists channel_project_id bigint references projects(id) on delete cascade;

commit;
