-- Accepted legacy snapshots contain autopilot_plan but may predate autopilot_settings.
-- Later 20260806 horizon migrations are additive and require both tables to exist.

begin;

create table if not exists autopilot_settings (
  user_id          bigint not null references users (id) on delete cascade,
  channel_id       bigint not null references channels (id) on delete cascade,
  enabled          boolean not null default false,
  mode             text not null default 'confirm' check (mode in ('confirm', 'full')),
  post_frequency   int not null default 5,
  approvals_streak int not null default 0,
  planning_months  smallint not null default 1,
  updated_at       timestamptz not null default now(),
  primary key (user_id, channel_id)
);

alter table autopilot_settings
  add column if not exists planning_months smallint not null default 1;
alter table autopilot_plan
  add column if not exists planning_months smallint not null default 1;

commit;
