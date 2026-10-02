begin;

-- Aurora получает выход в интернет как отдельную, проверяемую способность.
--
-- До этой миграции сетевые данные попадали в фичи разрозненно: Автопилот тянул RSS,
-- Радар — поисковую выдачу, а «Сегодня», «Карта возможностей», «Развитие» и «Инфоповоды»
-- работали только на внутренних сигналах. Общего места, где факт из сети хранится
-- вместе с доказательством и журналом проверки, не существовало.
--
-- Таблицы ниже закрывают ровно эту дыру:
--   web_research_runs     — один запуск исследования: план запросов и полный журнал;
--   web_research_findings — только те факты, что прошли ворота достоверности.
--
-- Факт без ссылки, без дословной цитаты в скачанном тексте и без даты публикации
-- сюда не попадает: ворота живут в src/lib/web-research-contract.mjs и работают
-- до записи в базу.

create table if not exists web_research_runs (
  id                bigint generated always as identity primary key,
  project_id        bigint not null references projects (id) on delete cascade,
  channel_id        bigint not null references channels (id) on delete cascade,
  trigger_kind      text not null default 'manual'
                      check (trigger_kind in ('manual', 'schedule', 'autopilot', 'today', 'chat', 'growth', 'opportunity')),
  topic             text not null default '',
  categories        text[] not null default '{}',
  language          varchar(8) not null default 'RU' check (language in ('RU', 'EN', 'ANY')),
  status            text not null default 'running' check (status in ('running', 'completed', 'failed')),
  plan_fingerprint  varchar(80) not null,
  queries           jsonb not null default '[]'::jsonb check (jsonb_typeof(queries) = 'array'),
  log               jsonb not null default '[]'::jsonb check (jsonb_typeof(log) = 'array'),
  stats             jsonb not null default '{}'::jsonb check (jsonb_typeof(stats) = 'object'),
  findings_count    integer not null default 0 check (findings_count >= 0),
  rejections_count  integer not null default 0 check (rejections_count >= 0),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  error             text
);
create index if not exists web_research_runs_scope_idx
  on web_research_runs (project_id, channel_id, started_at desc, id desc);

create index if not exists web_research_runs_retention_idx
  on web_research_runs (started_at);

-- Один и тот же запрос в пределах окна не должен ходить в сеть повторно: строка
-- с совпавшим plan_fingerprint и свежим started_at переиспользуется как кэш.
create index if not exists web_research_runs_fingerprint_idx
  on web_research_runs (project_id, channel_id, plan_fingerprint, started_at desc);

create table if not exists web_research_findings (
  id                   bigint generated always as identity primary key,
  run_id               bigint references web_research_runs (id) on delete set null,
  project_id           bigint not null references projects (id) on delete cascade,
  channel_id           bigint not null references channels (id) on delete cascade,
  fingerprint          varchar(80) not null,
  kind                 text not null
                         check (kind in ('law', 'benchmark', 'market', 'statistics', 'event', 'statement')),
  claim                text not null check (length(btrim(claim)) between 1 and 600),
  quote                text not null check (length(btrim(quote)) > 0),
  legal_status         text
                         check (legal_status is null or legal_status in (
                           'in_force', 'signed', 'adopted', 'bill_second_reading', 'bill_first_reading',
                           'bill_submitted', 'bill_drafted', 'public_discussion', 'not_normative'
                         )),
  language             varchar(8) not null default 'RU' check (language in ('RU', 'EN')),
  source_url           text not null check (source_url ~ '^https?://'),
  source_domain        varchar(253) not null check (length(btrim(source_domain)) between 1 and 253),
  source_label         varchar(300),
  source_tier          text not null check (source_tier in ('official', 'professional', 'research', 'media', 'open')),
  source_trust         smallint not null check (source_trust between 0 and 100),
  published_at         timestamptz not null,
  retrieved_at         timestamptz not null default now(),
  corroboration_count  integer not null default 0 check (corroboration_count >= 0),
  status               text not null default 'new' check (status in ('new', 'used', 'dismissed')),
  payload              jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object')
);

-- Дедупликация по отпечатку: один и тот же факт из одного источника не должен
-- порождать вторую карточку-инфоповод.
create unique index if not exists web_research_findings_fingerprint_idx
  on web_research_findings (project_id, channel_id, fingerprint);

create index if not exists web_research_findings_fresh_idx
  on web_research_findings (project_id, channel_id, status, published_at desc, id desc);

create index if not exists web_research_findings_kind_idx
  on web_research_findings (project_id, channel_id, kind, published_at desc);

commit;
