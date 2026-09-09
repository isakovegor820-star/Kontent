begin;

create table if not exists telegram_background_deliveries (
  project_id bigint not null references projects(id),
  user_id bigint not null references users(id),
  event_key varchar(200) not null check (event_key ~ '^[a-zA-Z0-9:_-]{1,200}$'),
  part_index integer not null check (part_index >= 0),
  bot_id bigint not null check (bot_id > 0),
  chat_id bigint not null check (chat_id <> 0),
  payload_hash char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  send_status text not null check (send_status in ('sending','sent','rejected','unknown','cancelled')),
  receipt jsonb,
  retry_not_before timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (project_id,user_id,event_key,part_index)
);
comment on table telegram_background_deliveries is
  'Durable per-event Telegram background receipts. Preserve sent/unknown/sending across retries and restart; never infer absent delivery from absent receipt. Restore quarantine holds all unfinished sends.';

commit;
