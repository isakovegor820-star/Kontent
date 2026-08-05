begin;

alter table competitor_posts add column if not exists analytics_lift numeric;
alter table competitor_posts add column if not exists analytics_er_bayes numeric;
alter table competitor_posts add column if not exists analytics_velocity numeric;
alter table competitor_posts add column if not exists analytics_velocity_z numeric;
alter table competitor_posts add column if not exists analytics_freshness numeric;
alter table competitor_posts add column if not exists analytics_score numeric;
alter table competitor_posts add column if not exists analytics_formula_version text;
alter table competitor_posts add column if not exists analytics_quality text;
alter table competitor_posts add column if not exists analytics_maturity text;
alter table competitor_posts add column if not exists analytics_computed_at timestamptz;

create table if not exists library_item_states (
  user_id     bigint      not null references users (id) on delete cascade,
  channel_id  bigint      not null references channels (id) on delete cascade,
  item_type   text        not null check (item_type in ('reference', 'idea', 'saved')),
  item_id     bigint      not null,
  rating      smallint    check (rating between 1 and 5),
  viewed_at   timestamptz,
  updated_at  timestamptz not null default now(),
  primary key (user_id, channel_id, item_type, item_id)
);
create index if not exists library_item_states_channel_idx
  on library_item_states (user_id, channel_id, item_type, updated_at desc);

create table if not exists library_export_snapshots (
  id              bigint generated always as identity primary key,
  user_id         bigint      not null references users (id) on delete cascade,
  channel_id      bigint      not null references channels (id) on delete cascade,
  request_key     varchar(96) not null,
  formula_version text        not null,
  snapshot        jsonb       not null check (jsonb_typeof(snapshot) = 'object'),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '7 days'),
  unique (user_id, request_key)
);
create index if not exists library_export_snapshots_expiry_idx
  on library_export_snapshots (expires_at);

commit;
