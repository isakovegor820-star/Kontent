-- Minimal pre-20260801 schema used only by the isolated migration integration test.
-- It intentionally contains two brands, account-wide library rows and a duplicate
-- Telegram message id so migrations must preserve data without cross-channel guessing.
create table users (
  id bigint generated always as identity primary key,
  email text unique,
  ai_mood text,
  ai_engine text
);

-- Sessions are part of the bootstrapped authentication baseline. Keep the
-- pre-credential-epoch shape so the password-race migration exercises its
-- actual additive upgrade instead of relying on the current schema snapshot.
create table sessions (
  token text primary key,
  user_id bigint not null references users (id) on delete cascade,
  expires_at timestamptz not null,
  device text,
  created_at timestamptz not null default now()
);
create index sessions_user_idx on sessions (user_id);

create table channels (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  network text not null default 'tg',
  title text,
  handle text,
  is_active boolean not null default true
);

-- Старый контракт брифа ещё не знал источник 'quiz'. Миграция обязана расширить
-- ограничение, не потеряв уже сохранённые AI/manual-брифы.
create table content_brief (
  user_id bigint not null references users (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  niche text,
  audience text,
  rubrics text[] not null default '{}',
  goal text,
  cta text,
  taboo text,
  quality jsonb not null default '{}'::jsonb,
  ready boolean not null default false,
  source text constraint content_brief_source_check check (source in ('ai', 'manual')),
  updated_at timestamptz not null default now(),
  primary key (user_id, channel_id)
);

create table posts (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  text text not null default '',
  scheduled_at timestamptz,
  status text not null default 'draft',
  tg_message_id bigint,
  vk_post_id bigint,
  external_post_id text,
  stats_state text,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  constraint posts_status_check check (status in ('draft','scheduled','publishing','published','failed'))
);

create table post_stats (
  id bigint generated always as identity primary key,
  post_id bigint not null references posts (id) on delete cascade,
  snapshot_date date not null,
  views int,
  collected_at timestamptz not null default now(),
  unique (post_id, snapshot_date)
);

create table ai_usage (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  usage_date date not null default current_date,
  kind text not null,
  created_at timestamptz not null default now()
);

create table saved_posts (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  text text not null,
  note text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table hashtag_sets (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  name text not null,
  tags text[] not null,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

-- Competitor intelligence was already part of the accepted pre-journal baseline.
-- Keep its original Telegram shape so later provider-neutral migrations exercise a
-- real additive upgrade instead of failing because the fixture omitted a core table.
create table competitors (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  network text not null default 'tg' check (network in ('tg', 'vk')),
  handle text not null,
  title text,
  subscribers integer,
  status text not null default 'pending' check (status in ('pending', 'ready', 'error')),
  last_error text,
  added_at timestamptz not null default now(),
  collected_at timestamptz,
  unique (channel_id, network, handle)
);

create table competitor_posts (
  id bigint generated always as identity primary key,
  competitor_id bigint not null references competitors (id) on delete cascade,
  tg_msg_id bigint not null,
  text text,
  views integer,
  reactions integer,
  posted_at timestamptz,
  collected_at timestamptz not null default now(),
  unique (competitor_id, tg_msg_id)
);

create table trend_sources (
  id bigint generated always as identity primary key,
  handle text not null unique,
  title text,
  category text not null default 'ниша' check (category in ('ниша', 'блог', 'отрасль')),
  subscribers integer,
  enabled boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'ready', 'error', 'no_feed')),
  last_error text,
  collected_at timestamptz,
  added_at timestamptz not null default now()
);

create table trend_posts (
  id bigint generated always as identity primary key,
  source_id bigint not null references trend_sources (id) on delete cascade,
  tg_msg_id bigint not null,
  text text,
  views integer,
  reactions integer,
  photo_url text,
  media text,
  posted_at timestamptz,
  collected_at timestamptz not null default now(),
  unique (source_id, tg_msg_id)
);

create table rss_feeds (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  is_active boolean not null default true
);

create table rss_items (
  id bigint generated always as identity primary key,
  feed_id bigint not null references rss_feeds (id) on delete cascade,
  post_id bigint references posts (id) on delete set null,
  status text not null default 'new'
);

create table media_generations (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  kind text not null,
  status text not null default 'queued'
);

-- Autopilot plans predate the incremental migration set. Keep the fixture deliberately
-- minimal, but include the relation required by the approval lease/outbox migration so
-- the integration run represents a genuinely bootstrapped legacy installation.
create table autopilot_plan (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  items jsonb not null default '[]'::jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

insert into users (id, email) overriding system value
values (1, 'legacy@example.test');
insert into channels (id, user_id, title, handle) overriding system value
values (10, 1, 'Brand A', 'brand_a'), (20, 1, 'Brand B', 'brand_b');
insert into content_brief (user_id, channel_id, niche, audience, source, ready)
values (1, 10, 'Legal tech', 'Lawyers', 'manual', true);
insert into posts
  (id, user_id, channel_id, text, status, tg_message_id, stats_state, published_at)
  overriding system value
values
  (101, 1, 10, 'canonical', 'published', 77, 'ok', now() - interval '1 day'),
  (102, 1, 10, 'duplicate', 'published', 77, 'gone', now() - interval '2 days'),
  (103, 1, 20, 'other brand', 'published', 77, 'ok', now() - interval '1 day');
insert into post_stats (post_id, snapshot_date, views) values (101, current_date, 5);
insert into ai_usage (user_id, kind) values (1, 'legacy');
insert into saved_posts (user_id, text) values (1, 'legacy account-wide post');
insert into hashtag_sets (user_id, name, tags) values (1, 'legacy tags', array['#legacy']);
insert into rss_feeds (id, user_id, channel_id) overriding system value values (301, 1, 10);
insert into rss_items (feed_id, status) values (301, 'skipped');
insert into media_generations (user_id, kind, status) values (1, 'image', 'failed');
