begin;

-- Persist the handoff before an interactive bot update can create a message. The
-- polling offset may be replayed after crashes; a sending row is never a retry proof.
create table if not exists telegram_update_deliveries (
  bot_id bigint not null,
  update_id bigint not null,
  part_index integer not null check (part_index >= 0),
  payload_hash char(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  send_status text not null check (send_status in ('sending','sent','rejected','unknown')),
  receipt jsonb,
  retry_not_before timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bot_id, update_id, part_index)
);

comment on table telegram_update_deliveries is
  'Bot update replay receipts. Contains payload hashes and minimal provider IDs only. Sending/unknown must not be resent; keep across worker restart and restore reconciliation.';

commit;
