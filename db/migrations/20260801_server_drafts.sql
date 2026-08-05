begin;

-- Черновик редактора — одна композиция, которая может быть предназначена сразу
-- нескольким каналам. `posts` намеренно остаётся очередью исполнения: одна строка
-- там соответствует одной публикации в один канал.
create table if not exists drafts (
  id            bigint generated always as identity primary key,
  user_id       bigint      not null references users (id) on delete cascade,
  text          text        not null default '',
  media         jsonb,
  scheduled_at  timestamptz,
  origin        text        not null default 'manual'
                            check (origin in ('manual','ai','trend','competitor','autopilot')),
  source_ref    jsonb,
  -- Ключ создаётся клиентом один раз на новый лист. Повтор того же POST после
  -- таймаута возвращает существующую строку и не создаёт двойник.
  client_key    text        not null,
  -- PATCH/DELETE обязаны передать текущую версию. Несовпадение даёт 409.
  version       bigint      not null default 1 check (version > 0),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, client_key)
);

create table if not exists draft_destinations (
  draft_id   bigint not null references drafts (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  primary key (draft_id, channel_id)
);

create index if not exists drafts_user_updated_idx
  on drafts (user_id, updated_at desc, id desc);

create index if not exists drafts_user_scheduled_idx
  on drafts (user_id, scheduled_at)
  where scheduled_at is not null;

create index if not exists draft_destinations_channel_idx
  on draft_destinations (channel_id, draft_id);

commit;
