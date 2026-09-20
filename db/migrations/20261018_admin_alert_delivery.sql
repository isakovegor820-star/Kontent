begin;

create table if not exists admin_alert_conditions (
  alert_id text primary key check (alert_id in ('database','redis','publication_worker','telegram_worker','overdue_publications')),
  firing boolean not null,
  generation bigint not null default 0 check (generation >= 0),
  since_ms bigint not null,
  current_notification_id bigint,
  updated_at timestamptz not null default now()
);
create table if not exists admin_alert_notifications (
  id bigint generated always as identity primary key,
  alert_id text not null references admin_alert_conditions(alert_id),
  generation bigint not null check (generation > 0),
  kind text not null check (kind in ('fired','still_firing','recovered')),
  severity text not null check (severity in ('critical','warning')),
  detail varchar(500) not null,
  since_ms bigint not null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  superseded_at timestamptz,
  unique(alert_id,generation)
);
create table if not exists admin_alert_deliveries (
  notification_id bigint not null references admin_alert_notifications(id),
  user_id bigint not null references users(id) on delete cascade,
  chat_id bigint not null,
  bot_id bigint not null check (bot_id > 0),
  send_status text not null default 'pending' check (send_status in ('pending','sending','sent','rejected','unknown')),
  attempt_token uuid,
  attempts integer not null default 0 check (attempts >= 0),
  sending_at timestamptz,
  retry_not_before timestamptz,
  receipt jsonb,
  last_error_code text,
  updated_at timestamptz not null default now(),
  primary key(notification_id,user_id),
  unique(notification_id,chat_id)
);
create index if not exists admin_alert_notifications_pending_idx
  on admin_alert_notifications(id) where completed_at is null and superseded_at is null;
comment on table admin_alert_deliveries is
  'Per-recipient admin alert receipts. Sending/unknown are never retry evidence; preserve across restart and restore.';

commit;
