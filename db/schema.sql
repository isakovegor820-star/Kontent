-- ============================================================================
-- Аврора · Схема базы данных
-- Шаг Д.1 — таблица заявок с лендинга (ТЗ v3, разделы 13.3 / 13.4).
--
-- Как применить (один раз):
--   Neon → твой проект → вкладка «SQL Editor» → вставь этот файл → Run.
--   Или из терминала:  psql "$DATABASE_URL" -f db/schema.sql
--
-- Файл идемпотентный: повторный запуск ничего не сломает (IF NOT EXISTS).
-- Каждый следующий шаг Д.2–Д.9 будет ДОБАВЛЯТЬ сюда свои таблицы рядом —
-- база одна на весь проект, данные не переносятся, а наследуются.
-- ============================================================================

-- ---------------------------------------------------------------- Д.1: leads
-- Заявки из листа ожидания. Из этой же таблицы вырастет CRM (этап 11) —
-- поэтому статусы будущей CRM заложены с первого дня.
create table if not exists leads (
  id          bigint generated always as identity primary key,

  -- Почта или @username. Уникально: повторная заявка не плодит строк.
  -- Храним в нижнем регистре, чтобы Artem@Mail.ru и artem@mail.ru не двоились.
  contact     text        not null unique,

  -- 'email' или 'telegram' — определяется автоматически по виду контакта.
  kind        text        not null check (kind in ('email', 'telegram')),

  -- Откуда пришла заявка (кнопка/секция лендинга) — для аналитики конверсии.
  source      text,

  -- Воронка будущей CRM. Новая заявка = 'new'.
  -- new → invited → registered → active.
  status      text        not null default 'new'
                          check (status in ('new', 'invited', 'registered', 'active')),

  -- Заметки владельца (заполняются позже, в кабинете CRM).
  note        text,

  -- С какого устройства пришли — для аналитики.
  user_agent  text,

  created_at  timestamptz not null default now()
);

-- Быстрый отбор свежих заявок в будущем кабинете владельца.
create index if not exists leads_created_at_idx on leads (created_at desc);

-- Отбор по статусу воронки (пригодится в CRM).
create index if not exists leads_status_idx on leads (status);


-- ------------------------------------------------------- Д.2: вход без паролей
-- Один человек = одна строка. Вход любым способом (Telegram/VK/почта) ведёт в
-- ОДИН аккаунт: если новый способ совпал по email/tg_id/vk_id — привязываем к
-- существующей строке, дубли не плодятся.
create table if not exists users (
  id            bigint generated always as identity primary key,
  tg_id         bigint unique,          -- Telegram id (может быть null)
  vk_id         bigint unique,          -- VK id (может быть null)
  email         text   unique,          -- почта, в нижнем регистре (может быть null)
  password_hash text,                   -- вход по паролю: scrypt-хеш (saltHex:hashHex), может быть null
  name          text,
  avatar        text,
  ai_mood       text,                   -- JSON-связка из 1–3 ключей src/lib/moods.ts; legacy-ключ тоже читается
  created_at    timestamptz not null default now()
);
-- Для старых баз, где таблица уже создана без этих колонок.
alter table users add column if not exists password_hash text;
alter table users add column if not exists ai_mood text;
-- Последние настройки конкретной публикации. Храним только отличия от Auto (jsonb),
-- а паспорт бренда/канала остаётся отдельно в knowledge_sources и content_brief.
-- Старые аккаунты получают пустой объект и автоматически нормализуются в безопасные
-- значения src/lib/post-settings.ts — миграция не переписывает пользовательские данные.
alter table users add column if not exists ai_post_settings jsonb not null default '{}'::jsonb;

-- Активные сессии. Выход = удаление строки (не только cookie).
-- Токен — случайная строка в cookie sid; срок 30 дней, продлевается при активности.
create table if not exists sessions (
  token       text        primary key,
  user_id     bigint      not null references users (id) on delete cascade,
  expires_at  timestamptz not null,
  device      text,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions (user_id);

-- Legacy email_codes intentionally is not created on a fresh database. If an older
-- installation still has it, this bootstrap snapshot leaves the table and its data
-- untouched; retention/deletion must be a separately approved migration.


-- --------------------------------------------- Д.3: публикация в Telegram
-- Подключённые каналы. Пользователь добавляет бота админом своего канала —
-- сервер публикует туда через Telegram Bot API. Один пользователь — много каналов.
create table if not exists channels (
  id          bigint generated always as identity primary key,
  user_id     bigint      not null references users (id) on delete cascade,
  network     text        not null default 'tg' check (network in ('tg', 'vk')),
  tg_chat_id  bigint,          -- id канала/чата в Telegram (для network='tg')
  tg_discussion_chat_id bigint, -- linked Telegram discussion group for comments and inbox
  vk_group_id bigint,          -- id сообщества VK (для network='vk')
  vk_token    text,            -- токен сообщества VK в виде AES-GCM-конверта (см. src/lib/token-crypto.mjs), никогда не plaintext
  title       text,
  handle      text,
  is_active   boolean     not null default true,
  status      text        not null default 'active'
                          constraint channels_status_check
                          check (status in ('active','needs_reconnect','permission_lost','revoked','disconnected')),
  last_auth_error_code text,
  last_auth_error_at timestamptz,
  disconnected_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint channels_active_telegram_chat_check
    check (network <> 'tg' or status <> 'active' or (is_active = true and tg_chat_id is not null))
);
create index if not exists channels_user_idx on channels (user_id);

-- ПРАВИЛО ВЛАДЕНИЯ КАНАЛОМ: один канал — ровно один аккаунт на всей платформе.
-- Без этого два человека независимо добавляют бота админом одного канала, оба
-- подключают его у себя — и канал получает каждый пост дважды. Это ровно тот дефект,
-- за который мы бьём Buffer в секции сравнения («посты дублируются»).
--
-- Индекс частичный, по is_active: отключил канал — освободил его для другого аккаунта.
-- Без этого условия первый, кто схватил канал, держал бы его вечно.
create unique index if not exists channels_tg_chat_active_uniq
  on channels (tg_chat_id)
  where tg_chat_id is not null and is_active;
create unique index if not exists channels_tg_discussion_chat_active_uniq
  on channels (tg_discussion_chat_id)
  where network = 'tg' and is_active and tg_discussion_chat_id is not null;

create unique index if not exists channels_vk_group_active_uniq
  on channels (vk_group_id)
  where vk_group_id is not null and is_active;

create table if not exists channel_events (
  id               bigint generated always as identity primary key,
  channel_id       bigint not null references channels (id) on delete cascade,
  actor_user_id    bigint references users (id) on delete set null,
  action           text not null,
  from_status      text,
  to_status        text not null,
  safe_error_code  text,
  request_id       text,
  created_at       timestamptz not null default now()
);
create index if not exists channel_events_channel_idx
  on channel_events (channel_id, created_at desc);
create unique index if not exists channel_events_request_uniq
  on channel_events (channel_id, request_id) where request_id is not null;

-- Посты. Публикует сервер по scheduled_at через очередь. Статусы — из ТЗ 5.3.
-- Надёжность: перед публикацией проверяем, что статус ещё не 'published' —
-- пост НИКОГДА не выходит дважды. Сбой → attempts+1 и до 3 автоповторов.
create table if not exists posts (
  id            bigint generated always as identity primary key,
  user_id       bigint      not null references users (id) on delete cascade,
  channel_id    bigint      not null references channels (id) on delete cascade,
  text          text        not null default '',
  media         jsonb,           -- ссылки на файлы/описание медиа (пока не грузим файлы)
  scheduled_at  timestamptz,     -- когда публиковать (null — черновик/очередь без даты)
  status        text        not null default 'draft'
                            check (status in ('draft','scheduled','publishing','published','failed')),
  tg_message_id bigint,          -- id вышедшего сообщения в Telegram
  vk_post_id    bigint,          -- id вышедшей записи VK (для network='vk'); ссылка: vk.com/wall-<group_id>_<vk_post_id>
  attempts      int         not null default 0,
  last_error    text,
  published_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists posts_channel_sched_idx on posts (channel_id, scheduled_at);
create index if not exists posts_status_idx on posts (status);
-- VK-колонка добавлена позже создания таблицы (Wave 1). Для существующих БД нужен
-- отдельный ALTER: create table if not exists уже созданную таблицу не меняет.
alter table posts add column if not exists vk_post_id bigint;


-- ------------------------------------------------- Д.5: аналитика (снимки)
-- Ежедневные снимки статистики поста. Одна строка = состояние на конкретный день,
-- чтобы строить динамику, а не только последнее число. NULL = сеть метрику не отдаёт
-- (честно «недоступно», а не ноль). Просмотры/реакции — из публичной страницы t.me/s/.
create table if not exists post_stats (
  id            bigint generated always as identity primary key,
  post_id       bigint      not null references posts (id) on delete cascade,
  snapshot_date date        not null,
  views         int,             -- реальные просмотры (t.me/s/); null — недоступно
  reactions     int,             -- сумма реакций (t.me/s/); null — недоступно
  reposts       int,             -- Telegram не отдаёт для бота → null
  comments      int,             -- Telegram не отдаёт для бота → null
  reach         int,             -- отдельного охвата нет → null
  collected_at  timestamptz not null default now(),
  unique (post_id, snapshot_date)
);
create index if not exists post_stats_post_idx on post_stats (post_id, snapshot_date);

-- Ежедневные снимки канала: число подписчиков и прирост за день. Для графика роста.
create table if not exists channel_stats (
  id                bigint generated always as identity primary key,
  channel_id        bigint      not null references channels (id) on delete cascade,
  snapshot_date     date        not null,
  subscribers       int         not null,  -- реальное число (getChatMemberCount)
  subscribers_delta int,                    -- прирост за день (null для первого снимка)
  collected_at      timestamptz not null default now(),
  unique (channel_id, snapshot_date)
);
create index if not exists channel_stats_channel_idx on channel_stats (channel_id, snapshot_date);


-- --------------------------------------------- Д.8: ИИ-контент (учёт генераций)
-- Одна строка = одна генерация. Дневной лимит считаем как count(*) за сегодня.
-- kind — что генерировали (write/rewrite/shorten/plan/script/image) для разбивки.
-- Лимит честный: ИИ стоит ресурсов, показываем счётчик пользователю (ТЗ 12, Д.8).
create table if not exists ai_usage (
  id          bigint generated always as identity primary key,
  user_id     bigint      not null references users (id) on delete cascade,
  usage_date  date        not null default current_date,
  kind        text        not null,
  created_at  timestamptz not null default now()
);
create index if not exists ai_usage_user_date_idx on ai_usage (user_id, usage_date);

create table if not exists ai_provider_attempts (
  id bigint generated always as identity primary key,
  user_id bigint not null references users (id) on delete cascade,
  ai_usage_id bigint references ai_usage (id) on delete set null,
  logical_operation_id uuid not null,
  phase text not null check (phase in ('draft','edit','auto-improve','topic-repair')),
  attempt_index integer not null check (attempt_index > 0),
  provider text not null,
  model text not null,
  input_tokens integer not null check (input_tokens >= 0),
  output_tokens integer not null check (output_tokens >= 0),
  usage_estimated boolean not null,
  latency_ms integer not null check (latency_ms >= 0),
  outcome text not null check (outcome in ('succeeded','failed','cancelled','budget_exhausted')),
  fallback boolean not null default false,
  estimated_cost_microusd bigint not null default 0 check (estimated_cost_microusd >= 0),
  safe_error_code text,
  request_correlation_id uuid not null,
  created_at timestamptz not null default now(),
  unique (logical_operation_id, attempt_index)
);
create index if not exists ai_provider_attempts_user_created_idx
  on ai_provider_attempts (user_id, created_at desc);
create index if not exists ai_provider_attempts_operation_idx
  on ai_provider_attempts (logical_operation_id, attempt_index);

-- ------------------------------------------- Д.8.1: изображения и видео
-- NavyAI отдаёт временную ссылку. Worker немедленно копирует файл в PostgreSQL, чтобы
-- результат не исчез после истечения provider job. Для первого production-MVP ставим
-- жёсткий лимит размера; object storage можно подключить позже без смены API для клиента.
create table if not exists media_assets (
  id               bigint generated always as identity primary key,
  user_id          bigint      not null references users (id) on delete cascade,
  kind             text        not null check (kind in ('image','video')),
  file_name        text        not null,
  mime_type        text        not null,
  bytes            int         not null,
  data             bytea,
  storage_backend  text        not null default 'postgres'
                               constraint media_assets_storage_backend_check
                               check (storage_backend in ('postgres','object')),
  object_key       text,
  object_etag      text,
  sha256           text        not null,
  duration_seconds int,
  created_at       timestamptz not null default now(),
  constraint media_assets_storage_payload_check check (
    (storage_backend = 'postgres' and data is not null and object_key is null)
    or (storage_backend = 'object' and data is null and object_key is not null)
  )
);
create index if not exists media_assets_user_idx on media_assets (user_id, created_at desc);
create unique index if not exists media_assets_object_key_uniq
  on media_assets (object_key) where object_key is not null;

create table if not exists media_object_orphans (
  id bigint generated always as identity primary key,
  object_key text not null unique,
  reason_code text not null,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists media_object_orphans_due_idx
  on media_object_orphans (next_attempt_at, id) where deleted_at is null;
create or replace function queue_deleted_media_object() returns trigger language plpgsql as $$
begin
  if old.storage_backend = 'object' and old.object_key is not null then
    insert into media_object_orphans (object_key, reason_code)
    values (old.object_key, 'asset_deleted')
    on conflict (object_key) do update
      set reason_code = excluded.reason_code, next_attempt_at = now(), deleted_at = null;
  end if;
  return old;
end $$;
drop trigger if exists media_assets_queue_object_delete on media_assets;
create trigger media_assets_queue_object_delete
  after delete on media_assets for each row execute function queue_deleted_media_object();

create table if not exists media_generations (
  id               bigint generated always as identity primary key,
  user_id          bigint      not null references users (id) on delete cascade,
  kind             text        not null check (kind in ('image','video')),
  status           text        not null default 'queued'
                               check (status in ('queued','submitting','generating','saving','ready','failed')),
  prompt           text        not null,
  negative_prompt  text,
  model            text        not null,
  aspect_ratio     text        not null,
  quality          text,
  seconds          int,
  style            text        not null default 'natural',
  niche            text,
  tone             text,
  request_id       uuid        not null default gen_random_uuid(),
  provider_request_key varchar(128) not null,
  prompt_policy_version smallint not null default 1
                               constraint media_generations_prompt_policy_version_check
                               check (prompt_policy_version between 1 and 3),
  prompt_context   jsonb       not null default '{}'::jsonb
                               constraint media_generations_prompt_context_check
                               check (jsonb_typeof(prompt_context) = 'object'),
  queue_confirmed_at timestamptz,
  provider_started_at timestamptz,
  provider_job_id  text,
  output_asset_id  bigint references media_assets (id) on delete set null,
  request_key      varchar(96),
  ai_usage_reservation_id bigint references ai_usage (id) on delete set null,
  error_code       text,
  error_message    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create index if not exists media_generations_user_idx on media_generations (user_id, created_at desc);
create index if not exists media_generations_active_idx on media_generations (status, updated_at)
  where status in ('queued','submitting','generating','saving');
create unique index if not exists media_generations_user_request_key_uniq
  on media_generations (user_id, request_key)
  where request_key is not null;
create unique index if not exists media_generations_request_id_uniq
  on media_generations (request_id);
create unique index if not exists media_generations_provider_request_key_uniq
  on media_generations (provider_request_key);


-- ------------------------------------------ Д.6: разведка конкурентов (Telegram)
-- ТОЛЬКО открытые данные: публичный канал → getChat (название), getChatMemberCount
-- (подписчики), t.me/s/<канал> (посты, время, просмотры, реакции). Закрытых данных
-- (демография аудитории, расходы, доходы) НЕ собираем и НЕ храним. Лимит — 20 на юзера.
create table if not exists competitors (
  id           bigint generated always as identity primary key,
  user_id      bigint      not null references users (id) on delete cascade,
  network      text        not null default 'tg' check (network in ('tg', 'vk')),
  handle       text        not null,   -- @username канала без @, нижний регистр
  title        text,                   -- название (getChat)
  subscribers  int,                    -- последнее известное число (null — ещё не собрано)
  status       text        not null default 'pending'
                           check (status in ('pending', 'ready', 'error')),
  last_error   text,                   -- почему не собралось (напр. приватный канал)
  added_at     timestamptz not null default now(),
  collected_at timestamptz,            -- когда последний раз обновляли досье
  unique (user_id, network, handle)
);
create index if not exists competitors_user_idx on competitors (user_id);

-- Посты конкурентов (открытые). reposts/comments Telegram по каналу не отдаёт → null.
create table if not exists competitor_posts (
  id            bigint generated always as identity primary key,
  competitor_id bigint      not null references competitors (id) on delete cascade,
  tg_msg_id     bigint      not null,
  text          text,
  views         int,             -- просмотры (t.me/s/)
  reactions     int,             -- сумма реакций (t.me/s/)
  posted_at     timestamptz,     -- время публикации
  collected_at  timestamptz not null default now(),
  unique (competitor_id, tg_msg_id)
);
create index if not exists competitor_posts_comp_idx on competitor_posts (competitor_id, posted_at);

-- Ежедневные снимки подписчиков конкурента — для графика/оценки роста.
create table if not exists competitor_stats (
  id            bigint generated always as identity primary key,
  competitor_id bigint      not null references competitors (id) on delete cascade,
  snapshot_date date        not null,
  subscribers   int,
  collected_at  timestamptz not null default now(),
  unique (competitor_id, snapshot_date)
);
create index if not exists competitor_stats_comp_idx on competitor_stats (competitor_id, snapshot_date);

-- Флаги залёта на постах конкурентов (Д.7): пост набрал в 5+ раз выше медианы автора.
alter table competitor_posts add column if not exists is_hit boolean not null default false;
alter table competitor_posts add column if not exists hit_ratio numeric;
-- Прозрачные метрики библиотеки. Их обновляет тот же worker, который собирает
-- сопоставимый cohort; formula_version позволяет объяснить исторический расчёт.
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


-- ------------------------------------------ Д.7: тренды и «Сними это» (идеи)
-- Идея из залёта конкурента. Детекция (is_hit) — чистая математика. Тема/хук/сценарий/
-- «почему сработало» пишет ИИ (Д.8): если движок подключён — заполнены; если нет —
-- null и ai_status='pending' (честно «сценарий появится, когда подключим ИИ»). Не выдумываем.
create table if not exists content_ideas (
  id             bigint generated always as identity primary key,
  user_id        bigint      not null references users (id) on delete cascade,
  competitor_id  bigint      references competitors (id) on delete cascade,
  source_post_id bigint      references competitor_posts (id) on delete set null,
  topic          text,
  hook           text,
  structure      text,
  why_it_worked  text,
  format         text,                    -- 'video' | 'post'
  hit_ratio      numeric,
  status         text        not null default 'new'
                             check (status in ('new', 'drafted', 'dismissed')),
  ai_status      text        not null default 'pending'
                             check (ai_status in ('pending', 'ready', 'skipped')),
  created_at     timestamptz not null default now(),
  unique (user_id, source_post_id)
);
create index if not exists content_ideas_user_idx on content_ideas (user_id, status, created_at);


-- ------------------------------------------------ Д.9: автопилот (дирижёр)
-- Слой-дирижёр над готовыми модулями: ИИ (Д.8) собирает план недели с опорой на аналитику
-- (Д.5) и залёты (Д.7) → пользователь одобряет → посты уходят в ту же очередь (Д.3).
create table if not exists autopilot_settings (
  user_id          bigint      primary key references users (id) on delete cascade,
  enabled          boolean     not null default false,
  mode             text        not null default 'confirm' check (mode in ('confirm', 'full')),
  post_frequency   int         not null default 5,   -- постов в неделю
  approvals_streak int         not null default 0,   -- недель подряд без правок (для полного режима)
  generation_engine text       not null default 'navy-deepseek-pro'
                               check (generation_engine in ('navy-deepseek-pro', 'navy-deepseek-flash', 'navy-gpt-5-4', 'navy-qwen-3-6', 'navy-minimax-m3')),
  planning_months smallint      not null default 1 check (planning_months in (1, 2, 3)),
  planning_weeks smallint       not null default 4 check (planning_weeks between 1 and 12),
  updated_at       timestamptz not null default now()
);

-- Один план на неделю. items — массив постов: {i, scheduledAt, topic, draft, status, postId}.
-- status поста: 'pending'|'approved'|'rejected'|'published'.
create table if not exists autopilot_plan (
  id         bigint generated always as identity primary key,
  user_id    bigint      not null references users (id) on delete cascade,
  week_start date        not null,
  items      jsonb       not null default '[]',
  rules      text,                    -- объяснение «почему так» из аналитики (ТЗ Д.9)
  edited     boolean     not null default false,  -- были ли ручные правки (для честного streak)
  generation_engine text not null default 'navy-deepseek-pro'
                         check (generation_engine in ('navy-deepseek-pro', 'navy-deepseek-flash', 'navy-gpt-5-4', 'navy-qwen-3-6', 'navy-minimax-m3')),
  planning_months smallint not null default 1 check (planning_months in (1, 2, 3)),
  planning_weeks smallint not null default 4 check (planning_weeks between 1 and 12),
  generation_post_frequency smallint not null default 5,
  expected_post_count smallint not null default 5,
  build_activity_at timestamptz not null default now(),
  status     text        not null default 'building'
                         check (status in ('building', 'pending', 'approving', 'approved', 'done', 'error')),
  created_at timestamptz not null default now()
);
create index if not exists autopilot_plan_user_idx on autopilot_plan (user_id, created_at desc);

-- Бриф контента (ТЗ Д.9). Без него автопилот не запускается: иначе ИИ не знает, о чём
-- канал, и пишет наугад. После channel-scoped migration один бриф принадлежит одному каналу.
-- source: чем заполнен — 'ai' (платформа прочитала канал), 'manual' или 'quiz' (онбординг).
-- Честность: ready ставит только сам пользователь, подтвердив бриф глазами.
create table if not exists content_brief (
  user_id    bigint      primary key references users (id) on delete cascade,
  niche      text,                    -- о чём канал (обязательно)
  audience   text,                    -- для кого (обязательно)
  rubrics    text[]      not null default '{}',  -- смысловые рубрики, которые чередуем
  goal       text,                    -- зачем канал автору
  cta        text,                    -- куда ведём читателя
  taboo      text,                    -- о чём не писать никогда
  quality    jsonb        not null default '{}'::jsonb, -- поканальный редакционный стандарт
  ready      boolean     not null default false,
  source     text        check (source in ('ai', 'manual', 'quiz')),
  updated_at timestamptz not null default now()
);

-- Разведка Д.6: тип медиа поста — считаем медиа-микс конкурента (что у него заходит:
-- текст, фото или видео). Реакции с t.me/s/ почти не отдаются (1 пост из 70), поэтому
-- на них ничего не строим — см. честный available в досье.
alter table competitor_posts add column if not exists media text;   -- 'photo' | 'video' | 'text'

-- Жёсткие правила качества — свойство канала. JSONB позволяет развивать контракт без
-- новой миграции на каждый переключатель, а нормализатор в приложении безопасно дополняет
-- старые профили новыми полями.
alter table content_brief add column if not exists quality jsonb not null default '{}'::jsonb;
alter table content_brief add column if not exists profile_answers jsonb not null default '{}'::jsonb;


-- ============================================================ Д.7+: «Насмотренность»
-- Вкладка «Общие тренды» обещала форматы/звуки/челленджи — соцсети их через API не отдают.
-- Разведка показала и большее: ТРЕНДОВ в скрапе Telegram нет ни при каком алгоритме.
-- Здесь нет алгоритмической ленты — подписчик видит каждый пост, поэтому просмотры почти
-- не гуляют (потолок ×2–4 к медиане даже у @durov), и выудить из них сигнал нечем:
-- ни по темам (частота слов даёт лексику), ни по формату (×0.97–1.08 — шум).
--
-- Поэтому раздел честно другой: не «тренды», а насмотренность — общий на всю платформу
-- список открытых каналов ниши, чьи посты ранжируются к СОБСТВЕННОЙ норме каждого канала.
-- Отличие от competitors: те у каждого свои (20 на человека), эти одни на всех — значит
-- и собираем их один раз в цикл, а не по разу на пользователя.
create table if not exists trend_sources (
  id           bigint generated always as identity primary key,
  handle       text        not null unique,   -- @username без @, нижний регистр
  title        text,
  -- Зачем канал в списке: 'ниша' — пишет о том же; 'блог' — личный блог (образец отклика);
  -- 'отрасль' — крупный отраслевой (темы и визуал).
  category     text        not null default 'ниша' check (category in ('ниша', 'блог', 'отрасль')),
  subscribers  int,
  enabled      boolean     not null default true,
  -- no_feed: канал отвечает, но ленту публично не показывает — досье собрать не из чего.
  -- Раньше такой канал молча становился 'ready' с нулём постов и выглядел нормальным.
  status       text        not null default 'pending'
                           check (status in ('pending', 'ready', 'error', 'no_feed')),
  last_error   text,
  collected_at timestamptz,
  added_at     timestamptz not null default now()
);
create index if not exists trend_sources_enabled_idx on trend_sources (enabled, collected_at);

-- Посты источников. Зеркалит competitor_posts, но живёт отдельно: у этих нет user_id,
-- нет лимита 20 и нет генерации идей — это витрина, а не разведка.
create table if not exists trend_posts (
  id           bigint generated always as identity primary key,
  source_id    bigint      not null references trend_sources (id) on delete cascade,
  tg_msg_id    bigint      not null,
  text         text,
  views        int,
  reactions    int,              -- null = реакции на канале выключены; 0 = никто не поставил
  photo_url    text,             -- прямая ссылка на картинку (cdn telesco.pe отдаёт с CORS *)
  media        text,             -- 'photo' | 'video' | 'text'
  posted_at    timestamptz,
  collected_at timestamptz not null default now(),
  unique (source_id, tg_msg_id)
);
create index if not exists trend_posts_source_idx on trend_posts (source_id, posted_at);

-- Картинка поста — для визуальной ленты. Колонка media уже есть выше (медиа-микс Д.6).
alter table competitor_posts add column if not exists photo_url text;

-- Засев списка. Каждый канал проверен живой разведкой: публичный, отдаёт посты и реакции.
-- Источник списка: рейтинг veta.expert (27 900 юридических каналов) + legalconf.ru, затем
-- собственная проверка t.me/s/ по каждому: подписчики, зрелые посты, фото, реакции, ER.
insert into trend_sources (handle, title, category) values
  -- Ядро ниши: пишут ровно о том же, о чём канал пользователя (ИИ + право)
  ('ilovedocs',                       'ilovedocs',                      'ниша'),
  ('legalmindai',                     'Юристы & Нейросети',             'ниша'),
  ('ai_and_law_rus',                  'ИИ & Право',                     'ниша'),
  -- Личные блоги юристов: ER 4–9% против 0,13% у крупных отраслевых — образец отклика
  ('bogdanova_msk',                   'Ваш Личный Юрист',               'блог'),
  ('mama_pravo',                      'Mama_pravo. Анастасия Попова',   'блог'),
  ('advokat_shvyreva',                'Адвокат Швырева Надежда',        'блог'),
  ('d_zhelnin',                       'Дмитрий Желнин пишет...',        'блог'),
  ('psvlaw',                          'Закон под подушкой',             'блог'),
  -- Отраслевые: много фото и текста — темы и визуал для ленты
  ('amolotnikov2020',                 'Анонимный Молотников',           'отрасль'),
  ('pgp_official',                    'Pepeliaev Group',                'отрасль'),
  ('alexeynikiforov_legalmanagement', 'Никифоров. Юридический менеджмент', 'отрасль'),
  ('lawfirms',                        'Рульфы, Ильфы и Инхаусы',        'отрасль')
on conflict (handle) do nothing;


-- ------------------------------------------- Д.8: выбор движка ИИ пользователем
-- Пикер в студии сохраняет выбор ВСЕГДА, даже если ключа к этому движку ещё нет:
-- подключишь ключ — заработает без правок кода. Молчаливой подмены нет: если выбран
-- движок без ключа, генерация честно откажет, а не напишет тайком локальной моделью.
alter table users add column if not exists ai_engine text;


-- ------------------------------------------- Д.5: почему статистики поста нет
-- «Недоступно» без причины бесполезно: человек не понимает, сломалось это или он сам
-- удалил пост. Воркер различает по номеру сообщения на публичной странице:
--   'ok'      — просмотры собраны
--   'gone'    — сообщения нет, хотя его номер попадает в видимое окно → удалён из канала
--   'private' — канал без публичной страницы, просмотров не будет вообще
--   null      — ещё не собирали
alter table posts add column if not exists stats_state text;


-- ============================================ Бот: привязка и интерактив (кнопки)
-- Раньше бот вещал в один чат из TG_CHAT_ID — то есть был личным рупором владельца,
-- а не частью продукта: второй пользователь не получил бы ничего, а его уведомления
-- пришли бы владельцу. Теперь каждый привязывает свой чат и получает СВОЁ.
--
-- tg_id ≠ tg_chat_id по смыслу: tg_id мы знаем после входа через Telegram, но писать
-- человеку бот может только если тот сам начал диалог. Отдельная колонка — это honest-флаг
-- «боту разрешено сюда писать», а не «мы знаем его телеграм».
alter table users add column if not exists tg_chat_id bigint;

-- Одноразовый код привязки. Кабинет выдаёт ссылку t.me/<bot>?start=<code>, бот по коду
-- понимает, КТО написал. Живёт 15 минут: это ключ от уведомлений, валяться не должен.
create table if not exists bot_links (
  code       text        primary key,
  user_id    bigint      not null references users (id) on delete cascade,
  used_at    timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists bot_links_user_idx on bot_links (user_id);

-- Безопасная обратная привязка Telegram → Аврора. Пользователь начинает её в личном
-- чате с ботом, а принадлежность аккаунта подтверждает в авторизованном веб-сеансе.
-- В базе хранится только SHA-256 отпечаток одноразового токена.
create table if not exists bot_connection_sessions (
  token_hash             char(64) primary key,
  telegram_user_id       bigint not null,
  telegram_chat_id       bigint not null,
  telegram_username      varchar(64),
  telegram_display_name  varchar(200) not null,
  confirmed_user_id      bigint references users (id) on delete cascade,
  used_at                timestamptz,
  revoked_at             timestamptz,
  expires_at             timestamptz not null,
  created_at             timestamptz not null default now(),
  constraint bot_connection_sessions_token_check check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint bot_connection_sessions_identity_check check (
    telegram_user_id > 0 and telegram_chat_id > 0
  ),
  constraint bot_connection_sessions_lifecycle_check check (
    ((used_at is null and confirmed_user_id is null) or
     (used_at is not null and confirmed_user_id is not null))
    and not (used_at is not null and revoked_at is not null)
  ),
  constraint bot_connection_sessions_expiry_check check (expires_at > created_at)
);
create unique index if not exists bot_connection_sessions_active_chat_idx
  on bot_connection_sessions (telegram_chat_id)
  where used_at is null and revoked_at is null;
create index if not exists bot_connection_sessions_expiry_idx
  on bot_connection_sessions (expires_at, created_at);
create index if not exists bot_connection_sessions_confirmed_user_idx
  on bot_connection_sessions (confirmed_user_id, used_at desc)
  where confirmed_user_id is not null;

-- Смещение очереди getUpdates. Храним в базе, а не в памяти: воркер перезапускается при
-- каждом деплое, а Telegram отдаёт обновления заново, пока их не подтвердили — без offset
-- после рестарта бот повторно обработал бы старые нажатия кнопок.
create table if not exists bot_state (
  id          int primary key default 1 check (id = 1),
  last_update bigint not null default 0,
  updated_at  timestamptz not null default now()
);
insert into bot_state (id) values (1) on conflict (id) do nothing;


-- ==================================== Д.6+: агент сам находит соседей по нише
-- У Telegram НЕТ поиска каналов: Bot API умеет только «дай канал по известному имени»,
-- а «похожие каналы» из приложения веб не отдаёт (проверено — в разметке t.me/s/ их нет).
-- Спрашивать у ИИ «назови юридические каналы» нельзя: он выдумает несуществующие handle'ы,
-- а это ровно та ложь, против которой построен весь продукт.
--
-- Зато каналы одной ниши ссылаются друг на друга — репостами, рекомендациями, упоминаниями
-- в постах. Это готовый граф, лежащий в открытой разметке. Идём по нему от своего канала и
-- уже добавленных конкурентов, каждого кандидата проверяем живьём и приносим на подтверждение.
-- Решает человек: платформа предлагает, а не добавляет за него.
create table if not exists competitor_suggestions (
  id           bigint generated always as identity primary key,
  user_id      bigint      not null references users (id) on delete cascade,
  handle       text        not null,           -- без @, нижний регистр
  title        text,
  description  text,                            -- публичное описание из шапки t.me/s/
  subscribers  int,
  posts        int,                            -- сколько постов видно на публичной странице
  last_post_at timestamptz,                    -- последний видимый публичный пост
  posts_per_week numeric(6,1),                 -- недавний темп по интервалам между постами
  -- Сколько РАЗНЫХ каналов ниши его упомянули. Один — совпадение, два и больше — сигнал.
  mentioned_by int         not null default 1,
  sources      text[]      not null default '{}',  -- кто именно упомянул: показываем человеку
  status       text        not null default 'new' check (status in ('new', 'added', 'dismissed')),
  found_at     timestamptz not null default now(),
  unique (user_id, handle)
);
create index if not exists competitor_suggestions_user_idx
  on competitor_suggestions (user_id, status, mentioned_by desc);


-- Вердикт «сосед по нише?» от ИИ (сверка постов кандидата с брифом канала).
--   true  — та же ниша, показываем
--   false — другая тема, прячем (но храним: не искать повторно)
--   null  — движка ИИ не было, судить некому → показываем честно как непроверенного
alter table competitor_suggestions add column if not exists on_topic boolean;


-- ───────────────────────────────────────────────────────────────────────────────
-- Автопилот и соседи — НА КАНАЛ, а не на аккаунт.
--
-- Было: autopilot_settings.user_id и content_brief.user_id — первичные ключи, у плана
-- канала не было вовсе, а семь мест в коде брали канал запросом
-- `... is_active = true limit 1` БЕЗ order by. У кого один канал — работало. У кого два —
-- автопилот молча писал в какой-то один (какой именно, Postgres не обещает) посты по брифу
-- другого, а второй канал не получал ничего. Бриф, настройки, план, конкуренты и находки
-- разведки описывают КАНАЛ, поэтому и живут на канале.
alter table autopilot_settings     add column if not exists channel_id bigint references channels (id) on delete cascade;
alter table content_brief          add column if not exists channel_id bigint references channels (id) on delete cascade;
alter table autopilot_plan         add column if not exists channel_id bigint references channels (id) on delete cascade;
alter table competitors            add column if not exists channel_id bigint references channels (id) on delete cascade;
alter table competitor_suggestions add column if not exists channel_id bigint references channels (id) on delete cascade;

-- Перенос существующих строк на самый ранний канал аккаунта (при одном канале это он и есть).
update autopilot_settings     s set channel_id = (select min(c.id) from channels c where c.user_id = s.user_id and c.network = 'tg') where s.channel_id is null;
update content_brief          b set channel_id = (select min(c.id) from channels c where c.user_id = b.user_id and c.network = 'tg') where b.channel_id is null;
update autopilot_plan         p set channel_id = (select min(c.id) from channels c where c.user_id = p.user_id and c.network = 'tg') where p.channel_id is null;
update competitors            k set channel_id = (select min(c.id) from channels c where c.user_id = k.user_id and c.network = 'tg') where k.channel_id is null;
update competitor_suggestions g set channel_id = (select min(c.id) from channels c where c.user_id = g.user_id and c.network = 'tg') where g.channel_id is null;

-- Не удаляем legacy-строки без канала. На чистой базе и на корректно обновлённой базе
-- nullable-остатков нет — тогда безопасно ужесточаем ключи. Если сироты существуют,
-- снимок оставляет их на месте и сообщает оператору: привязка требует отдельного решения.
do $$
begin
  if not exists (select 1 from autopilot_settings where channel_id is null)
     and not exists (select 1 from content_brief where channel_id is null) then
    alter table autopilot_settings alter column channel_id set not null;
    alter table content_brief alter column channel_id set not null;

    if not exists (
      select 1 from pg_constraint
       where conrelid = 'autopilot_settings'::regclass
         and contype = 'p'
         and pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id, channel_id)'
    ) then
      alter table autopilot_settings drop constraint if exists autopilot_settings_pkey;
      alter table autopilot_settings add primary key (user_id, channel_id);
    end if;

    if not exists (
      select 1 from pg_constraint
       where conrelid = 'content_brief'::regclass
         and contype = 'p'
         and pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id, channel_id)'
    ) then
      alter table content_brief drop constraint if exists content_brief_pkey;
      alter table content_brief add primary key (user_id, channel_id);
    end if;
  else
    raise notice 'Legacy Autopilot rows without a channel were preserved; channel keys were not tightened.';
  end if;

  if not exists (select 1 from autopilot_plan where channel_id is null) then
    alter table autopilot_plan alter column channel_id set not null;
  end if;
  if not exists (select 1 from competitors where channel_id is null) then
    alter table competitors alter column channel_id set not null;
  end if;
  if not exists (select 1 from competitor_suggestions where channel_id is null) then
    alter table competitor_suggestions alter column channel_id set not null;
  end if;
end $$;

-- Один и тот же канал может быть соседом двух моих каналов — это два разных суждения.
alter table competitors            drop constraint if exists competitors_user_id_network_handle_key;
alter table competitor_suggestions drop constraint if exists competitor_suggestions_user_id_handle_key;

-- Уникальность даём ИНДЕКСОМ, а не constraint'ом: у «alter table ... add constraint» в
-- Postgres нет «if not exists», и повторный накат этого файла падал с «relation already
-- exists» — хотя шапка обещает идемпотентность, а дописывать сюда и накатывать заново
-- и есть штатный процесс. Для «on conflict (channel_id, ...)» уникальный индекс
-- равнозначен constraint'у, а имена этих ключей в коде нигде не упоминаются.
create unique index if not exists competitors_channel_handle_key
  on competitors (channel_id, network, handle);
create unique index if not exists competitor_suggestions_channel_handle_key
  on competitor_suggestions (channel_id, handle);

create index if not exists autopilot_plan_channel_idx on autopilot_plan (channel_id, created_at desc);
create index if not exists competitors_channel_idx    on competitors (channel_id);

-- Кто добавил конкурента: человек или разведка сама (холодный старт, оба судьи ИИ «за»).
-- Нужно, чтобы автоматика не была сюрпризом: карточка помечена, и её видно, что убрать.
alter table competitors add column if not exists auto_added boolean not null default false;

-- ---------------------------------------------------------- Д.10: база знаний (RAG)
-- Откуда автопилот берёт ФАКТЫ для постов (src/app/api/knowledge/route.ts и воркер:
-- indexSource / findSupport). Эти таблицы жили ТОЛЬКО в запросах кода, а не в схеме —
-- свежий деплой по этому файлу ронял и API базы знаний, и RAG-часть воркера. Теперь
-- фича воспроизводится с нуля.
--
-- Голос и факты — РАЗНЫЕ виды кусков: свои посты канала (голос) идут образцом стиля,
-- опорой для утверждений они быть не могут. Иначе ИИ начал бы «опираться» на собственную
-- прошлую выдумку и закольцевал враньё: один раз соврал — навсегда стало «фактом из базы».

-- pgvector: косинусный поиск по эмбеддингам bge-m3 (1024 измерения). Сменишь модель
-- эмбеддингов — меняй и vector(N) ниже (см. EMBED_DIM в worker.mjs: сверяет размерность
-- на вставке, чтобы подмена модели не всплыла непонятной ошибкой Postgres).
create extension if not exists vector;

-- Источник знания: то, что человек вставил (форма/вставка), или срез стиля канала.
create table if not exists knowledge_sources (
  id          bigint generated always as identity primary key,
  user_id     bigint      not null references users (id) on delete cascade,
  channel_id  bigint      not null references channels (id) on delete cascade,

  -- 'form' | 'paste' | 'channel' | 'profile' | 'profile_edit'.
  -- 'channel' = срез стиля (голос): перечитал канал — прежний срез сносим.
  -- 'profile' = авто-профиль канала (ИИ-экстракция из постов): еженедельный крон
  -- перезаписывает свежим. 'profile_edit' = профиль после правок человека или из
  -- интервью: слова владельца, крон их НЕ трогает (api/knowledge/extract-profile).
  kind        text        not null check (kind in ('form', 'paste', 'channel', 'profile', 'profile_edit')),
  title       text        not null,
  raw_text    text        not null,

  -- pending → ready | error. Векторы считает воркер асинхронно (очередь knowledge-index):
  -- роут ждать не должен, человек видит «считаю» и через секунды «готово».
  status      text        not null default 'pending'
                          check (status in ('pending', 'ready', 'error')),
  last_error  text,
  added_at    timestamptz not null default now(),
  indexed_at  timestamptz
);

-- Ищем источники по каналу: список в GET и удаление среза стиля при перечитывании.
create index if not exists knowledge_sources_channel_idx on knowledge_sources (channel_id);

-- Куски: нарезка источника по авторским абзацам («один кусок = одна мысль», 80–900 знаков).
create table if not exists knowledge_chunks (
  id          bigint generated always as identity primary key,
  user_id     bigint      not null references users (id) on delete cascade,
  channel_id  bigint      not null references channels (id) on delete cascade,
  source_id   bigint      not null references knowledge_sources (id) on delete cascade,

  -- Вид наследуется от источника (worker.mjs indexSource): channel→voice, form→service,
  -- paste→fact. law/case/qa зарезервированы под будущие виды фактов.
  kind        text        not null
                          check (kind in ('voice', 'fact', 'law', 'case', 'qa', 'service')),
  text        text        not null,

  -- Вектор bge-m3, 1024 измерения. Считает воркер; null, пока не посчитан или движок
  -- недоступен (источник тогда висит pending — наполовину проиндексированный хуже никакого).
  embedding   vector(1024),

  -- Полнотекст по-русски: векторы глухи к цифрам и реквизитам («статья 446 ГПК» уходила
  -- в 0.395 при пороге 0.45), а слова — нет. Гибрид вектор+слова сливается по RRF
  -- в воркере (findSupport). Колонка генерируемая — сама пересчитывается при правке text.
  tsv         tsvector generated always as (to_tsvector('russian', text)) stored,

  -- Факты устаревают (изменился закон/сумма): после этой даты кусок из поиска выпадает.
  valid_until date,

  -- Честная ротация тем: реже использованные куски всплывают в плане недели первыми.
  used_count  int         not null default 0
);

-- Векторный поиск (косинус, оператор <=>): HNSW быстрее ivfflat и не требует тренировки.
create index if not exists knowledge_chunks_embedding_idx
  on knowledge_chunks using hnsw (embedding vector_cosine_ops);

-- Полнотекст: оператор @@ и ts_rank в лексической ветке findSupport.
create index if not exists knowledge_chunks_tsv_idx on knowledge_chunks using gin (tsv);

-- Самый частый фильтр — куски канала по виду (findSupport, счётчики фактов/голоса, сиды плана).
create index if not exists knowledge_chunks_channel_kind_idx on knowledge_chunks (channel_id, kind);


-- ==================================================== Wave 2: Библиотеки
-- Сохранённые посты (шаблоны, лучшие тексты) и наборы хэштегов.
-- Юзер сохраняет удачный пост из композера или добавляет вручную — потом вставляет повторно.
create table if not exists saved_posts (
  id         bigint generated always as identity primary key,
  user_id    bigint      not null references users (id) on delete cascade,
  text       text        not null,
  note       text,
  tags       text[]      not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists saved_posts_user_idx on saved_posts (user_id, created_at desc);

-- Наборы хэштегов: «Для постов про кофе», «Для юридических разборов» и т.д.
create table if not exists hashtag_sets (
  id         bigint generated always as identity primary key,
  user_id    bigint      not null references users (id) on delete cascade,
  name       text        not null,
  tags       text[]      not null,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

-- Библиотека — память конкретного канала, а не общий мешок аккаунта.
-- Nullable оставлен только для совместимости с аккаунтами, где канал ещё не подключён.
alter table saved_posts
  add column if not exists channel_id bigint references channels (id) on delete cascade;
alter table hashtag_sets
  add column if not exists channel_id bigint references channels (id) on delete cascade;

create index if not exists saved_posts_channel_idx
  on saved_posts (user_id, channel_id, created_at desc);

-- Постоянная история ИИ-студии. В БД лежит нормализованный снимок диалога,
-- а revision защищает новые сообщения от перезаписи устаревшей вкладкой.
create table if not exists studio_chat_sessions (
  user_id     bigint primary key references users (id) on delete cascade,
  payload     jsonb       not null,
  revision    bigint      not null default 1,
  updated_at  timestamptz not null default now(),
  constraint studio_chat_sessions_payload_check
    check (jsonb_typeof(payload) = 'object'),
  constraint studio_chat_sessions_revision_check
    check (revision > 0)
);
alter table hashtag_sets drop constraint if exists hashtag_sets_user_id_name_key;
create unique index if not exists hashtag_sets_channel_name_uniq
  on hashtag_sets (user_id, channel_id, name);
create unique index if not exists hashtag_sets_unassigned_name_uniq
  on hashtag_sets (user_id, name) where channel_id is null;

-- Сохранённый элемент может быть своим текстом или референсом из разведки.
-- Текст и источник копируем в коллекцию: запись остаётся полезной, даже если конкурент
-- позже удалён из разведки, а source_post_id при этом безопасно станет null.
alter table saved_posts add column if not exists kind text not null default 'own';
alter table saved_posts add column if not exists source_post_id bigint references competitor_posts (id) on delete set null;
alter table saved_posts add column if not exists source_title text;
alter table saved_posts add column if not exists source_url text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'saved_posts_kind_check') then
    alter table saved_posts
      add constraint saved_posts_kind_check check (kind in ('own', 'reference'));
  end if;
end $$;
create unique index if not exists saved_posts_reference_uniq
  on saved_posts (user_id, channel_id, source_post_id)
  where source_post_id is not null;

-- Оценка 1–5 и факт просмотра — пользовательские сигналы и намеренно хранятся
-- отдельно от объективного аналитического Score 0–100.
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

-- Все шесть файлов строятся из одного immutable JSON snapshot, поэтому повторная
-- загрузка другого формата не меняет состав реестра посреди экспорта.
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


-- ==================================================== Wave 2: RSS-репостер
-- Юзер добавляет RSS/Atom-ленту → воркер по cron парсит → ИИ суммаризирует → пост в очередь.
create table if not exists rss_feeds (
  id              bigint generated always as identity primary key,
  user_id         bigint      not null references users (id) on delete cascade,
  channel_id      bigint      not null references channels (id) on delete cascade,
  url             text        not null,
  title           text,
  -- Активный источник собирает материалы. Публикация разрешается отдельно.
  is_active       boolean     not null default false,
  auto_publish_enabled boolean not null default false,
  ai_summarize    boolean     not null default true,
  publish_existing boolean    not null default false,
  source_kind     text        not null default 'manual'
                              check (source_kind in ('manual', 'legal_opportunity')),
  max_per_day     int         not null default 3,
  last_fetched_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (user_id, url)
);
create index if not exists rss_feeds_user_idx on rss_feeds (user_id);
create index if not exists rss_feeds_user_source_kind_idx
  on rss_feeds (user_id, source_kind, channel_id, is_active);
alter table rss_feeds add column if not exists publish_existing boolean not null default false;
alter table rss_feeds add column if not exists auto_publish_enabled boolean not null default false;

create table if not exists rss_items (
  id           bigint generated always as identity primary key,
  feed_id      bigint      not null references rss_feeds (id) on delete cascade,
  guid         text        not null,
  title        text,
  link         text,
  summary      text,
  published_at timestamptz,
  post_id      bigint      references posts (id) on delete set null,
  status       text        not null default 'new' check (status in ('new', 'posted', 'skipped')),
  skip_reason  text        check (skip_reason in ('limit', 'irrelevant', 'baseline', 'paused')),
  fetched_at   timestamptz not null default now(),
  unique (feed_id, guid)
);
create index if not exists rss_items_feed_idx on rss_items (feed_id, fetched_at desc);

create table if not exists legal_opportunity_states (
  user_id      bigint      not null references users (id) on delete cascade,
  rss_item_id  bigint      not null references rss_items (id) on delete cascade,
  state        text        not null check (state in ('saved', 'dismissed', 'used')),
  updated_at   timestamptz not null default now(),
  primary key (user_id, rss_item_id)
);
create index if not exists legal_opportunity_states_user_state_idx
  on legal_opportunity_states (user_id, state, updated_at desc);

-- Project is a forward dependency for read state and editorial demand below. Define the
-- tenant root before those tables; membership and collaboration tables are added later.
create table if not exists projects (
  id                     bigint generated always as identity primary key,
  name                   varchar(160) not null,
  timezone               varchar(80) not null default 'UTC',
  created_by_user_id     bigint references users (id) on delete set null,
  personal_owner_user_id bigint unique references users (id) on delete cascade,
  is_archived            boolean not null default false,
  version                bigint not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint projects_name_check check (length(btrim(name)) between 1 and 160),
  constraint projects_timezone_check check (length(btrim(timezone)) between 1 and 80),
  constraint projects_version_check check (version > 0)
);

-- Непрочитанность считается отдельно для каждого пользователя и выбранного проекта.
-- Это состояние ортогонально saved/dismissed/used и сохраняется между сессиями.
create table if not exists legal_opportunity_reads (
  user_id      bigint      not null references users (id) on delete cascade,
  project_id   bigint      not null references projects (id) on delete cascade,
  rss_item_id  bigint      not null references rss_items (id) on delete cascade,
  read_at      timestamptz not null default now(),
  primary key (user_id, project_id, rss_item_id)
);
create index if not exists legal_opportunity_reads_scope_idx
  on legal_opportunity_reads (user_id, project_id, read_at desc);

alter table rss_feeds alter column is_active set default false;
alter table rss_items add column if not exists skip_reason text;
alter table rss_items drop constraint if exists rss_items_skip_reason_check;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'rss_items_skip_reason_check'
  ) then
    alter table rss_items
      add constraint rss_items_skip_reason_check
      check (skip_reason in ('limit', 'irrelevant', 'baseline', 'paused'));
  end if;
end $$;

-- ── Нишевой радар (Track 5) ─────────────────────────────────────────────────────
-- Полнотекстовый поиск по постам конкурентов
alter table competitor_posts
  add column if not exists tsv tsvector
  generated always as (to_tsvector('russian', coalesce(text, ''))) stored;
create index if not exists competitor_posts_tsv_idx
  on competitor_posts using gin (tsv);

-- Алерты по ключевым словам
create table if not exists niche_alerts (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references users (id) on delete cascade,
  channel_id bigint not null references channels (id) on delete cascade,
  keyword    text   not null,
  is_active  boolean not null default true,
  last_notified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (channel_id, keyword)
);

-- Найденные совпадения
create table if not exists niche_matches (
  id                 bigint generated always as identity primary key,
  alert_id           bigint not null references niche_alerts (id) on delete cascade,
  competitor_post_id bigint not null references competitor_posts (id) on delete cascade,
  notified           boolean not null default false,
  found_at           timestamptz not null default now(),
  unique (alert_id, competitor_post_id)
);
create index if not exists niche_matches_alert_idx on niche_matches (alert_id, found_at desc);

-- ── Gap-доспрос (невидимая база знаний) ─────────────────────────────────────
-- ИИ упёрся в пробел знаний (убрал из поста цифру, которой нет в базе; база пуста) —
-- вместо выдумки спрашивает человека в боте. Ответ уходит в knowledge_sources kind='form'.
-- Антиспам: та же topic не спрашивается 14 дней, pending одновременно не больше одного.
create table if not exists gap_questions (
  id          bigint generated always as identity primary key,
  user_id     bigint not null references users (id) on delete cascade,
  channel_id  bigint references channels (id) on delete cascade,
  topic       text   not null,              -- ключ дедупликации («empty-base», «plan-facts»)
  question    text   not null,
  status      text   not null default 'pending'
                     check (status in ('pending', 'answered', 'skipped')),
  answer      text,
  created_at  timestamptz not null default now(),
  answered_at timestamptz
);
create index if not exists gap_questions_user_pending_idx
  on gap_questions (user_id, status, created_at desc);

-- ============================================================================
-- Волна 2: зарубежные соцсети (YouTube первым, затем Instagram, X, TikTok, LinkedIn).
-- Бесплатно = нативный OAuth 2.0: пользователь жмёт «Подключить YouTube» → экран
-- согласия Google → редирект обратно → канал подключён. Никаких ручных токенов.
--
-- Основа строится один раз и переиспользуется для всех сетей:
--   1) расширяем набор сетей в channels + внешние id-колонки на сеть;
--   2) универсальная таблица oauth_tokens (access/refresh в AES-GCM конвертах);
--   3) channels.oauth_token_id — один источник правды для токена OAuth-сети;
--   4) posts.external_post_id — универсальный id вышедшей записи для OAuth-сетей.
-- ============================================================================

-- 1) Расширяем допустимые сети. Старое ограничение check (network in ('tg','vk'))
--    «дописать» нельзя — снимаем его и ставим новое (idempotent: drop if exists).
alter table channels drop constraint if exists channels_network_check;
alter table channels add constraint channels_network_check
  check (network in ('tg', 'vk', 'youtube', 'instagram', 'x', 'tiktok', 'linkedin'));

-- Внешние id аккаунта/канала у провайдера (по колонке на сеть, как tg_chat_id/vk_group_id).
alter table channels add column if not exists youtube_channel_id   text;
alter table channels add column if not exists instagram_account_id text;
alter table channels add column if not exists x_account_id         text;
alter table channels add column if not exists tiktok_account_id    text;
alter table channels add column if not exists linkedin_account_id  text;

-- 2) Универсальные OAuth-токены. Одна строка = связка (пользователь, провайдер, аккаунт).
--    access_token/refresh_token — ТОЛЬКО в виде AES-GCM конверта (src/lib/token-crypto.mjs,
--    AAD = user_id:provider), никогда не plaintext. expires_at — когда истечёт access_token
--    (для YouTube refresh_token бессрочный при offline-доступе; у Instagram access_token на 60 дней).
create table if not exists oauth_tokens (
  id            bigint generated always as identity primary key,
  user_id       bigint      not null references users (id) on delete cascade,
  provider      text        not null,   -- 'youtube' | 'instagram' | 'x' | 'tiktok' | 'linkedin'
  external_id   text,                   -- id аккаунта/канала у провайдера (например, YouTube channel id)
  access_token  text        not null,   -- AES-GCM конверт
  refresh_token text,                   -- AES-GCM конверт (может быть null)
  scopes        text,                   -- выданные скоупы через пробел (для диагностики)
  expires_at    timestamptz,            -- когда истечёт access_token (null = бессрочный)
  meta          jsonb,                  -- название канала, аватар, handle и т.п. (для UI без лишнего API-вызова)
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists oauth_tokens_user_idx on oauth_tokens (user_id, provider);
-- Активный токен одного провайдера и аккаунта — один на пользователя (повторное подключение
-- обновляет существующую строку, а не плодит дубли). external_id может быть null до резолва.
create unique index if not exists oauth_tokens_active_uniq
  on oauth_tokens (user_id, provider, external_id)
  where is_active and external_id is not null;

-- 3) Канал OAuth-сети ссылается на свой токен. Один источник правды: публикация и
--    обновление токена идут через oauth_tokens, а channels хранит только витринные данные.
alter table channels add column if not exists oauth_token_id bigint references oauth_tokens (id) on delete set null;

-- Правило владения для новых сетей (по образцу tg/vk): один аккаунт платформы — один
-- активный канал на всей платформе. Частичный индекс по is_active — отключил → освободил.
create unique index if not exists channels_youtube_active_uniq
  on channels (youtube_channel_id)   where youtube_channel_id   is not null and is_active;
create unique index if not exists channels_instagram_active_uniq
  on channels (instagram_account_id) where instagram_account_id is not null and is_active;
create unique index if not exists channels_x_active_uniq
  on channels (x_account_id)         where x_account_id         is not null and is_active;
create unique index if not exists channels_tiktok_active_uniq
  on channels (tiktok_account_id)    where tiktok_account_id    is not null and is_active;
create unique index if not exists channels_linkedin_active_uniq
  on channels (linkedin_account_id)  where linkedin_account_id  is not null and is_active;

-- 4) Универсальный id вышедшей записи для OAuth-сетей (video id у YouTube, media id у
--    Instagram, tweet id у X). tg_message_id/vk_post_id остаются под свои сети.
alter table posts add column if not exists external_post_id text;


-- ============================================================================
-- Production launch safety additions (2026-08-01).
-- This file is the bootstrap snapshot for a NEW database. Existing databases are
-- upgraded only by `npm run db:migrate`; the migration runner records checksums and
-- never treats this snapshot as an in-place upgrade script.
-- ============================================================================

-- Account-scoped onboarding completion. Browser storage is only a recovery cache.
alter table users add column if not exists onboarding_completed_at timestamptz;

-- Password recovery stores only a SHA-256 token hash and consumes a token once.
create table if not exists password_reset_tokens (
  id              bigint generated always as identity primary key,
  user_id         bigint      not null references users (id) on delete cascade,
  token_hash      text        not null unique,
  request_ip_hash text,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now(),
  check (length(token_hash) = 64)
);
create index if not exists password_reset_tokens_user_active_idx
  on password_reset_tokens (user_id, expires_at desc)
  where used_at is null;

-- AI quota lifecycle: reserve before a paid call, then commit or release explicitly.
alter table ai_usage add column if not exists status text not null default 'committed';
alter table ai_usage add column if not exists reservation_key varchar(128);
alter table ai_usage add column if not exists reserved_at timestamptz;
alter table ai_usage add column if not exists expires_at timestamptz;
alter table ai_usage add column if not exists finalized_at timestamptz;
alter table ai_usage add column if not exists operation_id uuid;
alter table ai_usage add column if not exists request_fingerprint varchar(64);
alter table ai_usage add column if not exists result_payload jsonb;
alter table ai_usage add column if not exists result_content_type varchar(80);
update ai_usage
   set finalized_at = coalesce(finalized_at, created_at)
 where status = 'committed' and finalized_at is null;
alter table ai_usage drop constraint if exists ai_usage_status_check;
alter table ai_usage add constraint ai_usage_status_check
  check (status in ('reserved', 'committed', 'released', 'expired'));
alter table ai_usage drop constraint if exists ai_usage_reservation_fields_check;
alter table ai_usage add constraint ai_usage_reservation_fields_check check (
  status <> 'reserved'
  or (reservation_key is not null and reserved_at is not null and expires_at is not null)
);
do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'ai_usage_request_fingerprint_check'
  ) then
    alter table ai_usage add constraint ai_usage_request_fingerprint_check
      check (request_fingerprint is null or request_fingerprint ~ '^[a-f0-9]{64}$');
  end if;
end $$;
create unique index if not exists ai_usage_user_reservation_key_uniq
  on ai_usage (user_id, reservation_key)
  where reservation_key is not null;
create index if not exists ai_usage_active_user_date_idx
  on ai_usage (user_id, usage_date, status);
create index if not exists ai_usage_reserved_expiry_idx
  on ai_usage (expires_at, id)
  where status = 'reserved';
create unique index if not exists ai_usage_operation_id_uniq
  on ai_usage (operation_id)
  where operation_id is not null;

-- Every Autopilot approval is idempotent and auditable without duplicating post text.
create table if not exists autopilot_approval_operations (
  id                bigserial primary key,
  user_id           bigint       not null references users (id) on delete cascade,
  channel_id        bigint       not null references channels (id) on delete cascade,
  plan_id           bigint,
  idempotency_key   varchar(128) not null,
  actor_type        text         not null check (actor_type in ('web', 'bot', 'system')),
  status            text         not null check (status in ('processing', 'completed', 'partial', 'failed')),
  request_snapshot  jsonb        not null default '{}'::jsonb,
  result            jsonb,
  http_status       integer      not null default 200,
  created_at        timestamptz  not null default now(),
  completed_at      timestamptz,
  unique (user_id, idempotency_key)
);
create index if not exists autopilot_approval_operations_plan_idx
  on autopilot_approval_operations (plan_id, created_at desc);
create index if not exists autopilot_approval_operations_channel_idx
  on autopilot_approval_operations (channel_id, created_at desc);

-- Reclaimable/fenced Autopilot approval lease plus a transactional per-item outbox.
alter table autopilot_plan add column if not exists approval_operation_id bigint
  references autopilot_approval_operations (id) on delete set null;
alter table autopilot_plan add column if not exists approval_started_at timestamptz;
alter table autopilot_plan add column if not exists approval_heartbeat_at timestamptz;
create table if not exists autopilot_schedule_outbox (
  id            bigint generated always as identity primary key,
  plan_id       bigint      not null references autopilot_plan (id) on delete cascade,
  item_index    integer     not null check (item_index >= 0),
  user_id       bigint      not null references users (id) on delete cascade,
  channel_id    bigint      not null references channels (id) on delete cascade,
  operation_id  bigint      references autopilot_approval_operations (id) on delete set null,
  post_id       bigint      not null unique references posts (id) on delete cascade,
  scheduled_at  timestamptz not null,
  status        text        not null default 'pending'
                             check (status in ('pending', 'enqueued', 'cancelled')),
  attempts      integer     not null default 0 check (attempts >= 0),
  last_error    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  enqueued_at   timestamptz,
  unique (plan_id, item_index)
);
create index if not exists autopilot_schedule_outbox_pending_idx
  on autopilot_schedule_outbox (updated_at, id) where status = 'pending';
create index if not exists autopilot_schedule_outbox_operation_idx
  on autopilot_schedule_outbox (operation_id, id);

-- Publication truth and replay safety. A local send result is not treated as current
-- external truth until reconciliation has verified the external object.
alter table posts add column if not exists external_message_id text;
alter table posts add column if not exists publish_started_at timestamptz;
alter table posts add column if not exists publish_lease_token text;
alter table posts add column if not exists last_verification_attempt_at timestamptz;
alter table posts add column if not exists last_verified_at timestamptz;
alter table posts add column if not exists verification_state text not null default 'unverified';
alter table posts add column if not exists verification_result jsonb not null default '{}'::jsonb;
alter table posts add column if not exists verification_error_code text;
alter table posts add column if not exists verification_error_reason text;
alter table posts add column if not exists consecutive_missing_checks integer not null default 0;
alter table posts add column if not exists idempotency_key text;
alter table posts add column if not exists request_fingerprint text;
alter table posts add column if not exists last_retry_key text;
alter table posts add column if not exists retry_requested_at timestamptz;
alter table posts drop constraint if exists posts_status_check;
alter table posts add constraint posts_status_check check (
  status in (
    'draft', 'scheduled', 'publishing', 'published_unverified', 'published',
    'missing', 'deleted_external', 'failed'
  )
);
alter table posts drop constraint if exists posts_verification_state_check;
alter table posts add constraint posts_verification_state_check check (
  verification_state in ('unverified', 'verified', 'missing', 'unverifiable')
);
update posts
   set external_message_id = coalesce(
     external_message_id,
     tg_message_id::text,
     vk_post_id::text,
     external_post_id
   )
 where external_message_id is null;
update posts
   set status = 'published_unverified',
       verification_state = 'unverifiable',
       verification_result = jsonb_build_object(
         'result', 'legacy_missing_signal',
         'source', 'legacy_stats_state'
       )
 where status = 'published' and stats_state = 'gone';
update posts p
   set verification_state = 'verified',
       last_verified_at = coalesce(
         (select max(s.collected_at) from post_stats s where s.post_id = p.id),
         p.published_at
       ),
       verification_result = jsonb_build_object('result', 'seen', 'source', 'legacy_stats')
 where p.status = 'published'
   and p.stats_state = 'ok'
   and p.external_message_id is not null;
update posts
   set status = 'published_unverified',
       verification_result = case
         when verification_result = '{}'::jsonb
           then jsonb_build_object('result', 'unverified_legacy')
         else verification_result
       end
 where status = 'published' and verification_state <> 'verified';
with ranked_external_ids as (
  select id,
         row_number() over (
           partition by channel_id, external_message_id
           order by (stats_state = 'ok') desc nulls last, published_at desc nulls last, id desc
         ) as external_rank
    from posts
   where external_message_id is not null
)
update posts p
   set external_message_id = null,
       status = case when p.status = 'published' then 'published_unverified' else p.status end,
       verification_state = 'unverifiable',
       verification_result = coalesce(p.verification_result, '{}'::jsonb)
         || jsonb_build_object('result', 'duplicate_legacy_external_id')
  from ranked_external_ids ranked
 where p.id = ranked.id and ranked.external_rank > 1;
create unique index if not exists posts_channel_external_message_uniq
  on posts (channel_id, external_message_id)
  where external_message_id is not null;
create unique index if not exists posts_user_idempotency_key_uniq
  on posts (user_id, idempotency_key)
  where idempotency_key is not null;
create unique index if not exists posts_user_request_fingerprint_uniq
  on posts (user_id, request_fingerprint)
  where request_fingerprint is not null;
create index if not exists posts_verified_published_idx
  on posts (channel_id, published_at desc)
  where status = 'published' and verification_state = 'verified';

-- Server-owned editor drafts. `posts` remains the execution queue: one row per
-- destination; a draft is one editable composition with optimistic concurrency.
create table if not exists drafts (
  id            bigint generated always as identity primary key,
  user_id       bigint      not null references users (id) on delete cascade,
  text          text        not null default '',
  formatting    jsonb       not null default '[]'::jsonb
                            constraint drafts_formatting_array_check
                            check (jsonb_typeof(formatting) = 'array'),
  media         jsonb,
  scheduled_at  timestamptz,
  scheduled_timezone varchar(80),
  scheduled_local_date date,
  scheduled_local_time time,
  scheduled_offset varchar(6),
  scheduled_disambiguation text
    constraint drafts_scheduled_disambiguation_check
    check (scheduled_disambiguation is null or scheduled_disambiguation in ('reject','earlier','later')),
  origin        text        not null default 'manual'
                            check (origin in ('manual','ai','trend','idea','competitor','rss','autopilot')),
  source_ref    jsonb,
  client_key    text        not null,
  version       bigint      not null default 1 check (version > 0),
  review_policy_version integer not null default 1 check (review_policy_version = 1),
  ai_validation jsonb,
  human_reviewed_version bigint,
  human_reviewed_at timestamptz,
  purpose       text        not null default 'needs_review'
                            check (purpose in ('source_context','publishable','needs_review')),
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

-- Реальные вопросы аудитории как редакционный спрос: одинаковые вопросы внутри
-- проекта накапливают частоту, а не размножаются карточками. Отдельные появления
-- сохраняют источник и контекст, чтобы ответ можно было проверить и закрыть.
create table if not exists audience_questions (
  id                     bigint generated always as identity primary key,
  project_id             bigint       not null references projects (id) on delete cascade,
  created_by_user_id     bigint       not null references users (id) on delete restrict,
  question               text         not null constraint audience_questions_question_length_check
                                      check (char_length(question) between 3 and 600),
  question_fingerprint   char(64)     not null constraint audience_questions_fingerprint_check
                                      check (question_fingerprint ~ '^[0-9a-f]{64}$'),
  topic                  varchar(160),
  priority               smallint     not null default 2 constraint audience_questions_priority_check
                                      check (priority between 1 and 3),
  occurrences            integer      not null default 1 constraint audience_questions_occurrences_check
                                      check (occurrences between 1 and 1000000),
  status                 text         not null default 'new'
                                      constraint audience_questions_status_check
                                      check (status in ('new','drafting','planned','answered','dismissed')),
  generation_request_key varchar(128),
  draft_client_key       varchar(160),
  answer_draft_id        bigint references drafts (id) on delete set null,
  version                bigint       not null default 1 constraint audience_questions_version_check
                                      check (version > 0),
  first_seen_at          timestamptz  not null default now(),
  last_seen_at           timestamptz  not null default now(),
  answered_at            timestamptz,
  created_at             timestamptz  not null default now(),
  updated_at             timestamptz  not null default now(),
  constraint audience_questions_project_fingerprint_key unique (project_id, question_fingerprint),
  constraint audience_questions_generation_keys_check
    check ((generation_request_key is null) = (draft_client_key is null)),
  constraint audience_questions_answered_at_check
    check ((status = 'answered') = (answered_at is not null))
);
create index if not exists audience_questions_project_queue_idx
  on audience_questions (project_id, status, priority desc, occurrences desc, last_seen_at desc);
create index if not exists audience_questions_project_topic_idx
  on audience_questions (project_id, topic, last_seen_at desc)
  where topic is not null;

create table if not exists audience_question_occurrences (
  id                   bigint generated always as identity primary key,
  project_id           bigint       not null references projects (id) on delete cascade,
  question_id          bigint       not null references audience_questions (id) on delete cascade,
  submitted_by_user_id bigint       not null references users (id) on delete restrict,
  request_key          varchar(128) not null,
  source_type          text         not null
                                    constraint audience_question_occurrences_source_type_check
                                    check (source_type in ('manual','comment','direct_message','support','sales','search','other')),
  source_label         varchar(200),
  source_url           text,
  context              text,
  occurrence_count     integer      not null default 1
                                    constraint audience_question_occurrences_count_check
                                    check (occurrence_count between 1 and 10000),
  occurred_at          timestamptz  not null default now(),
  created_at           timestamptz  not null default now(),
  constraint audience_question_occurrences_project_request_key unique (project_id, request_key)
);
create index if not exists audience_question_occurrences_question_idx
  on audience_question_occurrences (question_id, occurred_at desc, id desc);

-- Immutable server-owned lineage for paid text generation. The editable draft points to
-- a result, never the other way around, so changing a draft cannot mutate provider output.
create table if not exists generation_operations (
  id                     bigint generated always as identity primary key,
  user_id                bigint not null references users (id) on delete cascade,
  ai_usage_id            bigint not null references ai_usage (id) on delete restrict,
  request_key            varchar(128) not null,
  server_request_id      uuid not null,
  request_fingerprint    char(64) not null,
  channel_id             bigint not null references channels (id) on delete restrict,
  source_context_id      bigint references drafts (id) on delete restrict,
  source_context_version bigint,
  input_draft_id         bigint references drafts (id) on delete restrict,
  input_draft_version    bigint,
  provider_engine        varchar(80) not null,
  provider_model         varchar(160) not null,
  status                 text not null default 'running'
                         check (status in ('running','pending_ack','acknowledged','failed','retryable_failed')),
  error_code             varchar(100),
  retryable              boolean not null default false,
  acknowledged_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (user_id, request_key),
  unique (ai_usage_id),
  check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  check ((source_context_id is null) = (source_context_version is null)),
  check ((input_draft_id is null) = (input_draft_version is null)),
  check (source_context_version is null or source_context_version > 0),
  check (input_draft_version is null or input_draft_version > 0)
);
create unique index if not exists generation_operations_user_request_id_uniq
  on generation_operations (user_id, server_request_id);
create index if not exists generation_operations_recovery_idx
  on generation_operations (user_id, status, updated_at desc);

create table if not exists generation_results (
  id              bigint generated always as identity primary key,
  operation_id    bigint not null references generation_operations (id) on delete restrict,
  result_hash     char(64) not null check (result_hash ~ '^[0-9a-f]{64}$'),
  text            text not null,
  provider_result jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (operation_id)
);
create table if not exists validation_receipts (
  id                   bigint generated always as identity primary key,
  generation_result_id bigint not null references generation_results (id) on delete restrict,
  result_hash          char(64) not null check (result_hash ~ '^[0-9a-f]{64}$'),
  status               text not null check (status in ('passed','blocked','not_checked')),
  receipt              jsonb not null,
  created_at           timestamptz not null default now(),
  unique (generation_result_id)
);
alter table drafts add column if not exists generation_result_id bigint
  references generation_results (id) on delete restrict;
create index if not exists drafts_generation_result_idx
  on drafts (generation_result_id) where generation_result_id is not null;
create index if not exists drafts_publishable_user_updated_idx
  on drafts (user_id, updated_at desc, id desc) where purpose <> 'source_context';

-- Ledger is owned by the migration runner. It is included here so schema inspection
-- and fresh-database snapshots describe the same operational schema.
create table if not exists schema_migrations (
  name       text primary key,
  checksum   char(64) not null,
  applied_at timestamptz not null default now()
);

-- Release safety: an old scheduled timestamp is not perpetual consent to publish.
alter table posts add column if not exists publication_origin text not null default 'legacy';
alter table posts add column if not exists next_attempt_at timestamptz;
alter table posts add column if not exists quarantined_at timestamptz;
alter table posts add column if not exists quarantine_reason text;
alter table posts add column if not exists schedule_revision bigint not null default 1;

alter table posts drop constraint if exists posts_publication_origin_check;
alter table posts add constraint posts_publication_origin_check check (
  publication_origin in ('manual', 'ai', 'trend', 'idea', 'competitor', 'autopilot', 'rss', 'retry', 'legacy')
);
alter table posts drop constraint if exists posts_schedule_revision_check;
alter table posts add constraint posts_schedule_revision_check check (schedule_revision > 0);

-- One Composer action is one immutable revision across every destination.
create table if not exists publication_operations (
  id               bigint generated always as identity primary key,
  user_id          bigint not null references users (id) on delete cascade,
  draft_id         bigint references drafts (id) on delete set null,
  draft_version    bigint not null check (draft_version > 0),
  idempotency_key  varchar(128) not null,
  fingerprint      varchar(64) not null,
  text             text not null,
  media            jsonb,
  scheduled_at     timestamptz not null,
  timezone         varchar(80) not null default 'UTC',
  schedule_offset  varchar(6),
  schedule_disambiguation text
    constraint publication_operations_schedule_disambiguation_check
    check (schedule_disambiguation is null or schedule_disambiguation in ('reject','earlier','later')),
  destination_ids  jsonb not null,
  options           jsonb not null default '{}'::jsonb,
  schedule_revision bigint not null default 1 check (schedule_revision > 0),
  status            text not null default 'pending'
                    check (status in ('pending','partial','queued','published_unverified','published','failed','cancelled')),
  cancelled_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create unique index if not exists publication_operations_draft_revision_uniq
  on publication_operations (user_id, draft_id, draft_version) where draft_id is not null;
create unique index if not exists publication_operations_fingerprint_uniq
  on publication_operations (user_id, fingerprint);
alter table posts add column if not exists publication_operation_id bigint
  references publication_operations (id) on delete set null;
alter table posts add column if not exists publication_draft_version bigint;
alter table posts add column if not exists provider_started_at timestamptz;
alter table posts add column if not exists cancelled_at timestamptz;
alter table posts add column if not exists provider_operation_id text;
alter table posts add column if not exists provider_reconciliation_state text not null default 'none';
alter table posts add column if not exists provider_reconciliation_requested_at timestamptz;
alter table posts add column if not exists scheduled_timezone varchar(80);
alter table posts add column if not exists scheduled_offset varchar(6);
alter table posts add column if not exists scheduled_disambiguation text;
alter table posts drop constraint if exists posts_scheduled_disambiguation_check;
alter table posts add constraint posts_scheduled_disambiguation_check check (
  scheduled_disambiguation is null or scheduled_disambiguation in ('reject','earlier','later')
);
alter table posts drop constraint if exists posts_provider_reconciliation_state_check;
alter table posts add constraint posts_provider_reconciliation_state_check check (
  provider_reconciliation_state in ('none','pending','confirmed','unresolved','failed')
);
create unique index if not exists posts_publication_operation_destination_uniq
  on posts (publication_operation_id, channel_id) where publication_operation_id is not null;
create unique index if not exists posts_provider_operation_identity_uniq
  on posts (channel_id, provider_operation_id) where provider_operation_id is not null;
create table if not exists publication_outbox (
  id               bigint generated always as identity primary key,
  operation_id     bigint not null references publication_operations (id) on delete cascade,
  post_id           bigint not null references posts (id) on delete cascade,
  status            text not null default 'pending'
                    check (status in ('pending','dispatching','enqueued','failed','cancelled')),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  last_error_code   text,
  lease_token       text,
  lease_expires_at  timestamptz,
  enqueued_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (post_id)
);
create index if not exists publication_outbox_due_idx
  on publication_outbox (next_attempt_at, id) where status in ('pending','failed');

create table if not exists publication_operation_events (
  id                    bigint generated always as identity primary key,
  operation_id          bigint not null references publication_operations (id) on delete cascade,
  actor_user_id         bigint not null references users (id) on delete cascade,
  action                text not null check (action in ('cancel','reschedule','restore_draft')),
  idempotency_key       varchar(128) not null,
  expected_revision     bigint not null check (expected_revision > 0),
  resulting_revision    bigint not null check (resulting_revision > 0),
  from_status           text not null,
  to_status             text not null,
  request_id            varchar(128),
  result                jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  unique (operation_id, idempotency_key)
);
create index if not exists publication_operation_events_operation_idx
  on publication_operation_events (operation_id, created_at desc, id desc);

-- Password changes fence concurrent login and reset generations; delivery is async.
alter table users add column if not exists credential_epoch bigint not null default 1;
alter table users add column if not exists password_reset_generation bigint not null default 0;
alter table users drop constraint if exists users_credential_epoch_check;
alter table users add constraint users_credential_epoch_check check (credential_epoch > 0);
alter table users drop constraint if exists users_password_reset_generation_check;
alter table users add constraint users_password_reset_generation_check check (password_reset_generation >= 0);
alter table sessions add column if not exists credential_epoch bigint;
update sessions s set credential_epoch = u.credential_epoch
  from users u where u.id = s.user_id and s.credential_epoch is null;
alter table sessions alter column credential_epoch set not null;
create index if not exists sessions_user_epoch_idx on sessions (user_id, credential_epoch);
alter table password_reset_tokens add column if not exists generation bigint;
update password_reset_tokens t set generation = greatest(1, u.password_reset_generation)
  from users u where u.id = t.user_id and t.generation is null;
alter table password_reset_tokens alter column generation set not null;
alter table password_reset_tokens drop constraint if exists password_reset_tokens_generation_check;
alter table password_reset_tokens add constraint password_reset_tokens_generation_check check (generation > 0);
create unique index if not exists password_reset_tokens_user_generation_uniq
  on password_reset_tokens (user_id, generation);
create table if not exists password_reset_outbox (
  id                bigint generated always as identity primary key,
  user_id           bigint not null references users (id) on delete cascade,
  token_id          bigint not null unique references password_reset_tokens (id) on delete cascade,
  generation        bigint not null,
  recipient         text not null,
  token_envelope    text not null,
  status            text not null default 'pending'
                    check (status in ('pending','sending','sent','failed','cancelled')),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  lease_token       text,
  lease_expires_at  timestamptz,
  last_error_code   text,
  sent_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists password_reset_outbox_due_idx
  on password_reset_outbox (next_attempt_at, id) where status in ('pending','failed');

create table if not exists publication_parts (
  id                    bigint generated always as identity primary key,
  post_id               bigint not null references posts (id) on delete cascade,
  part_index            integer not null check (part_index >= 0),
  part_type             text not null check (part_type in ('text','media','media_caption')),
  payload_html          text,
  payload_hash          char(64)
                        constraint publication_parts_payload_hash_check
                        check (payload_hash is null or payload_hash ~ '^[0-9a-f]{64}$'),
  entity_length         integer
                        constraint publication_parts_entity_length_check
                        check (
                          entity_length is null
                          or (
                            entity_length >= 0
                            and entity_length <= case when part_type = 'media_caption' then 1024 else 4096 end
                          )
                        ),
  external_message_id   text,
  send_status           text not null default 'pending'
                        check (send_status in ('pending','sending','sent','failed','unknown')),
  verification_state    text not null default 'unverified'
                        check (verification_state in ('unverified','verified','missing','unverifiable')),
  attempts              integer not null default 0 check (attempts >= 0),
  last_error_code       text,
  last_verified_at      timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (post_id, part_index)
);
create index if not exists publication_parts_external_idx
  on publication_parts (post_id, external_message_id) where external_message_id is not null;

create table if not exists trend_refresh_operations (
  id               bigint generated always as identity primary key,
  user_id          bigint not null references users (id) on delete cascade,
  idempotency_key  varchar(128) not null,
  fingerprint      varchar(160) not null,
  status           text not null default 'dispatching'
                   check (status in ('dispatching','accepted','failed')),
  queued_count     integer not null default 0 check (queued_count >= 0),
  last_error_code  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create unique index if not exists trend_refresh_operations_active_fingerprint_uniq
  on trend_refresh_operations (user_id, fingerprint) where status = 'dispatching';
alter table posts drop constraint if exists posts_status_check;
alter table posts add constraint posts_status_check check (
  status in (
    'draft', 'scheduled', 'publishing', 'published_unverified', 'published',
    'missing', 'deleted_external', 'failed_retry', 'quarantined', 'cancelled', 'failed'
  )
);
create index if not exists posts_reconciliation_due_idx
  on posts (status, scheduled_at, next_attempt_at, id)
  where status in ('scheduled', 'failed_retry');
create index if not exists posts_quarantined_user_idx
  on posts (user_id, quarantined_at desc, id desc)
  where status = 'quarantined';

-- A bulk approval is bound to the exact revision/hash shown to the user.
alter table autopilot_plan add column if not exists revision bigint not null default 1;
alter table autopilot_plan drop constraint if exists autopilot_plan_revision_check;
alter table autopilot_plan add constraint autopilot_plan_revision_check check (revision > 0);
alter table autopilot_approval_operations add column if not exists plan_revision bigint;
alter table autopilot_approval_operations add column if not exists preview_hash char(64);
create table if not exists autopilot_approval_previews (
  token_hash     char(64) primary key,
  user_id        bigint not null references users (id) on delete cascade,
  channel_id     bigint not null references channels (id) on delete cascade,
  plan_id        bigint not null references autopilot_plan (id) on delete cascade,
  plan_revision  bigint not null check (plan_revision > 0),
  preview_hash   char(64) not null,
  snapshot       jsonb not null,
  expires_at     timestamptz not null,
  consumed_at    timestamptz,
  operation_id   bigint references autopilot_approval_operations (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists autopilot_approval_previews_expiry_idx
  on autopilot_approval_previews (expires_at, token_hash)
  where consumed_at is null;
create index if not exists autopilot_approval_previews_plan_idx
  on autopilot_approval_previews (plan_id, plan_revision, created_at desc);

-- Profile editor extends the existing channel-owned content_brief; it does not create
-- a parallel questionnaire. Email changes require password/provider reauthentication,
-- a durable one-time token and idempotent outbox delivery.
alter table content_brief add column if not exists formats text[] not null default '{}';
alter table content_brief add column if not exists author_role text not null default '';

create table if not exists profile_update_operations (
  id                  bigint generated always as identity primary key,
  user_id             bigint not null references users (id) on delete cascade,
  request_key         varchar(128) not null,
  request_fingerprint varchar(64) not null,
  result_payload      jsonb not null,
  created_at          timestamptz not null default now(),
  unique (user_id, request_key),
  check (length(request_fingerprint) = 64),
  check (jsonb_typeof(result_payload) = 'object')
);

alter table users add column if not exists email_change_generation bigint not null default 0;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'users_email_change_generation_check') then
    alter table users add constraint users_email_change_generation_check
      check (email_change_generation >= 0);
  end if;
end $$;

create table if not exists email_change_requests (
  id                  bigint generated always as identity primary key,
  user_id             bigint not null references users (id) on delete cascade,
  request_key         varchar(128) not null,
  request_fingerprint varchar(64) not null,
  target_email        text not null,
  token_hash          varchar(64) not null unique,
  generation          bigint not null check (generation > 0),
  expires_at          timestamptz not null,
  confirmed_at        timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, request_key),
  unique (user_id, generation),
  check (length(request_fingerprint) = 64),
  check (target_email = lower(target_email)),
  check (confirmed_at is null or cancelled_at is null)
);
create index if not exists email_change_requests_user_active_idx
  on email_change_requests (user_id, expires_at desc)
  where confirmed_at is null and cancelled_at is null;

create table if not exists email_change_outbox (
  id                bigint generated always as identity primary key,
  user_id           bigint not null references users (id) on delete cascade,
  request_id        bigint not null unique references email_change_requests (id) on delete cascade,
  generation        bigint not null,
  recipient         text not null,
  token_envelope    text not null,
  status            text not null default 'pending'
                    check (status in ('pending','sending','sent','failed','cancelled')),
  attempts          integer not null default 0 check (attempts >= 0),
  next_attempt_at   timestamptz not null default now(),
  lease_token       text,
  lease_expires_at  timestamptz,
  last_error_code   text,
  sent_at           timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists email_change_outbox_due_idx
  on email_change_outbox (next_attempt_at, id)
  where status in ('pending','failed');

-- Safe, background website analysis. The confirmed domain and immutable request identity
-- are stored before BullMQ dispatch; a run revision makes late/replayed jobs inert.
create table if not exists site_analysis_jobs (
  id                  bigint generated always as identity primary key,
  user_id             bigint not null references users (id) on delete cascade,
  request_id          text not null unique,
  idempotency_key     text not null,
  request_fingerprint text not null,
  target_url          text not null,
  confirmed_domain    text not null,
  consented_at        timestamptz not null,
  status              text not null default 'queued',
  stage               text not null default 'queued',
  progress            integer not null default 0,
  progress_detail     text,
  limits              jsonb not null default '{}'::jsonb,
  result              jsonb,
  prompt_version      text not null default 'site-osint-interview-v1',
  question_catalog_version text not null default 'site-osint-questions-v1',
  snapshot_hash       text,
  coverage_mode       text not null default 'site_only',
  answered_count      integer not null default 0,
  question_count      integer not null default 0,
  ai_usage_reservation_id bigint references ai_usage (id) on delete set null,
  error_code          text,
  error_message       text,
  attempts            integer not null default 0,
  run_revision        integer not null default 1,
  last_retry_key      text,
  queue_confirmed_at  timestamptz,
  worker_lease_token  text,
  worker_heartbeat_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz,
  constraint site_analysis_jobs_status_check
    check (status in ('queued', 'crawling', 'analyzing', 'planning', 'saving', 'ready', 'failed')),
  constraint site_analysis_jobs_stage_check
    check (stage in ('queued', 'robots', 'sitemap', 'crawling', 'extracting', 'resolving_entities', 'researching_external', 'answering', 'validating', 'planning', 'saving', 'ready', 'failed')),
  constraint site_analysis_jobs_progress_check check (progress between 0 and 100),
  constraint site_analysis_jobs_attempts_check check (attempts >= 0),
  constraint site_analysis_jobs_run_revision_check check (run_revision > 0),
  constraint site_analysis_jobs_limits_check check (jsonb_typeof(limits) = 'object'),
  constraint site_analysis_jobs_result_check check (result is null or jsonb_typeof(result) = 'object'),
  constraint site_analysis_jobs_snapshot_hash_check check (snapshot_hash is null or snapshot_hash ~ '^sha256:[a-f0-9]{64}$'),
  constraint site_analysis_jobs_coverage_mode_check check (coverage_mode in ('site_only', 'external')),
  constraint site_analysis_jobs_answer_counts_check check (answered_count >= 0 and question_count >= 0 and answered_count <= question_count),
  constraint site_analysis_jobs_user_idempotency_key_key unique (user_id, idempotency_key)
);
create index if not exists site_analysis_jobs_user_created_idx
  on site_analysis_jobs (user_id, created_at desc);
create index if not exists site_analysis_jobs_queued_idx
  on site_analysis_jobs (status, updated_at)
  where status in ('queued', 'crawling', 'analyzing', 'planning');

create table if not exists site_analysis_pages (
  id               bigint generated always as identity primary key,
  analysis_id      bigint not null references site_analysis_jobs (id) on delete cascade,
  url              text not null,
  http_status      integer not null,
  title            text,
  description      text,
  headings         jsonb not null default '[]'::jsonb,
  main_content     text,
  schema_types     text[] not null default '{}',
  links            jsonb not null default '[]'::jsonb,
  ctas             jsonb not null default '[]'::jsonb,
  forms            jsonb not null default '[]'::jsonb,
  public_comments  jsonb not null default '[]'::jsonb,
  technical        jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  constraint site_analysis_pages_headings_check check (jsonb_typeof(headings) = 'array'),
  constraint site_analysis_pages_links_check check (jsonb_typeof(links) = 'array'),
  constraint site_analysis_pages_ctas_check check (jsonb_typeof(ctas) = 'array'),
  constraint site_analysis_pages_forms_check check (jsonb_typeof(forms) = 'array'),
  constraint site_analysis_pages_public_comments_check check (jsonb_typeof(public_comments) = 'array'),
  constraint site_analysis_pages_technical_check check (jsonb_typeof(technical) = 'object'),
  constraint site_analysis_pages_analysis_id_url_key unique (analysis_id, url)
);
create index if not exists site_analysis_pages_analysis_idx
  on site_analysis_pages (analysis_id, id);

create table if not exists site_analysis_sources (
  id bigint generated always as identity primary key,
  analysis_id bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision integer not null,
  source_key text not null,
  source_kind text not null check (source_kind in ('owned_page','owned_document','structured_data','external_editorial','partner_page','event_page','official_social','public_registry','user_file')),
  url text not null,
  title text not null,
  page_type text not null,
  is_primary boolean not null default false,
  published_at timestamptz,
  modified_at timestamptz,
  checked_at timestamptz not null,
  quality text not null check (quality in ('high','medium','low','unavailable')),
  content_hash text not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  constraint site_analysis_sources_run_source_key unique (analysis_id, run_revision, source_key),
  constraint site_analysis_sources_run_url_key unique (analysis_id, run_revision, url)
);
create index if not exists site_analysis_sources_analysis_run_idx on site_analysis_sources (analysis_id, run_revision, id);

create table if not exists site_analysis_evidence (
  id bigint generated always as identity primary key,
  analysis_id bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision integer not null,
  source_id bigint not null references site_analysis_sources (id) on delete cascade,
  evidence_key text not null,
  evidence_hash text not null,
  evidence_type text not null,
  fact_type text not null,
  value jsonb not null check (jsonb_typeof(value) in ('string','number','boolean','object','array')),
  extracted_by text not null,
  quality text not null check (quality in ('high','medium','low','unavailable')),
  currentness text not null,
  checked_at timestamptz not null,
  published_at timestamptz,
  injection_signal boolean not null default false,
  created_at timestamptz not null default now(),
  constraint site_analysis_evidence_run_key unique (analysis_id, run_revision, evidence_key),
  constraint site_analysis_evidence_run_hash unique (analysis_id, run_revision, evidence_hash)
);
create index if not exists site_analysis_evidence_analysis_run_idx on site_analysis_evidence (analysis_id, run_revision, source_id, id);

create table if not exists site_analysis_entities (
  id bigint generated always as identity primary key,
  analysis_id bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision integer not null,
  entity_key text not null,
  entity_type text not null check (entity_type in ('organization','person','product','partner','event','topic','channel','document')),
  canonical_key text not null,
  name text not null,
  attributes jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  evidence_keys jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_keys) = 'array'),
  confidence text not null check (confidence in ('high','medium','low','none')),
  created_at timestamptz not null default now(),
  constraint site_analysis_entities_run_key unique (analysis_id, run_revision, entity_key),
  constraint site_analysis_entities_run_canonical unique (analysis_id, run_revision, entity_type, canonical_key)
);
create index if not exists site_analysis_entities_analysis_run_idx on site_analysis_entities (analysis_id, run_revision, entity_type, id);

create table if not exists site_analysis_relations (
  id bigint generated always as identity primary key,
  analysis_id bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision integer not null,
  relation_key text not null,
  from_entity_key text not null,
  to_entity_key text not null,
  relation_type text not null,
  relation_status text not null check (relation_status in ('observed','claimed','confirmed','historical','conflicting')),
  valid_from timestamptz,
  valid_to timestamptz,
  evidence_keys jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_keys) = 'array'),
  confidence text not null check (confidence in ('high','medium','low','none')),
  created_at timestamptz not null default now(),
  constraint site_analysis_relations_run_key unique (analysis_id, run_revision, relation_key)
);
create index if not exists site_analysis_relations_analysis_run_idx on site_analysis_relations (analysis_id, run_revision, relation_type, id);

create table if not exists site_analysis_ai_batches (
  id bigint generated always as identity primary key,
  analysis_id bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision integer not null,
  batch_id text not null,
  semantic_key text not null,
  provider_request_key text not null unique,
  request_fingerprint text not null,
  status text not null default 'queued' check (status in ('queued','generating','ready','failed')),
  engine text,
  response_payload jsonb check (response_payload is null or jsonb_typeof(response_payload) = 'object'),
  error_code text,
  attempts integer not null default 0 check (attempts >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint site_analysis_ai_batches_run_batch_key unique (analysis_id, run_revision, batch_id)
);
create index if not exists site_analysis_ai_batches_dispatch_idx on site_analysis_ai_batches (status, updated_at) where status in ('queued','generating');

create table if not exists site_analysis_answers (
  id bigint generated always as identity primary key,
  analysis_id bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision integer not null,
  question_id text not null,
  question_version integer not null,
  status text not null check (status in ('answered','hypothesis','conflicting','insufficient_data')),
  short_answer text not null,
  explanation text not null,
  facts jsonb not null default '[]'::jsonb check (jsonb_typeof(facts) = 'array'),
  evidence_keys jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_keys) = 'array'),
  confidence text not null check (confidence in ('high','medium','low','none')),
  contradictions jsonb not null default '[]'::jsonb check (jsonb_typeof(contradictions) = 'array'),
  gaps jsonb not null default '[]'::jsonb check (jsonb_typeof(gaps) = 'array'),
  required_integrations jsonb not null default '[]'::jsonb check (jsonb_typeof(required_integrations) = 'array'),
  recommendation_hooks jsonb not null default '[]'::jsonb check (jsonb_typeof(recommendation_hooks) = 'array'),
  created_at timestamptz not null default now(),
  constraint site_analysis_answers_run_question_key unique (analysis_id, run_revision, question_id)
);
create index if not exists site_analysis_answers_analysis_run_idx on site_analysis_answers (analysis_id, run_revision, status, id);

create table if not exists site_analysis_recommendations (
  id bigint generated always as identity primary key,
  analysis_id bigint not null references site_analysis_jobs (id) on delete cascade,
  run_revision integer not null,
  recommendation_key text not null,
  question_id text not null,
  kind text not null,
  rationale text not null,
  confidence text not null check (confidence in ('high','medium','low')),
  entity_keys jsonb not null default '[]'::jsonb check (jsonb_typeof(entity_keys) = 'array'),
  evidence_keys jsonb not null default '[]'::jsonb check (jsonb_typeof(evidence_keys) = 'array'),
  created_at timestamptz not null default now(),
  constraint site_analysis_recommendations_run_key unique (analysis_id, run_revision, recommendation_key)
);
create index if not exists site_analysis_recommendations_analysis_run_idx on site_analysis_recommendations (analysis_id, run_revision, id);

-- Licensed legal-source adapters. Public ConsultantPlus/GARANT RSS entries remain in
-- the versioned RSS catalog; only encrypted official API credentials are persisted here.
create table if not exists legal_source_connections (
  id                     bigint generated always as identity primary key,
  user_id                bigint not null references users (id) on delete cascade,
  provider_id            varchar(64) not null,
  provider_label         varchar(120) not null,
  integration_kind       varchar(32) not null,
  token_envelope         text,
  status                 varchar(24) not null default 'connected',
  subscription_status    varchar(24) not null default 'unknown',
  external_account_label varchar(300),
  token_expires_at       timestamptz,
  sync_cursor            text,
  last_sync_at           timestamptz,
  last_health_at         timestamptz,
  last_error_code        varchar(80),
  last_error_message     varchar(500),
  disconnected_at        timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint legal_source_connections_user_provider_key unique (user_id, provider_id),
  constraint legal_source_connections_provider_id_check
    check (provider_id ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  constraint legal_source_connections_kind_check
    check (integration_kind in ('official_api','vendor_export','user_file','licensed_integration')),
  constraint legal_source_connections_status_check
    check (status in ('connected','invalid','expired','disconnected')),
  constraint legal_source_connections_subscription_check
    check (subscription_status in ('active','trial','expired','inactive','unknown')),
  constraint legal_source_connections_token_check
    check (
      status = 'disconnected'
      or integration_kind in ('vendor_export','user_file')
      or token_envelope is not null
    )
);
create index if not exists legal_source_connections_user_idx
  on legal_source_connections (user_id, updated_at desc);

create table if not exists legal_source_operations (
  id                  bigint generated always as identity primary key,
  user_id             bigint not null references users (id) on delete cascade,
  connection_id       bigint references legal_source_connections (id) on delete set null,
  provider_id         varchar(64) not null,
  operation           varchar(24) not null,
  request_key         varchar(128) not null,
  request_fingerprint char(64) not null,
  status              varchar(24) not null default 'dispatching',
  lease_token         uuid,
  lease_expires_at    timestamptz,
  result_payload      jsonb,
  http_status         smallint,
  last_error_code     varchar(80),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint legal_source_operations_user_request_key unique (user_id, request_key),
  constraint legal_source_operations_operation_check
    check (operation in ('connect','validate','sync','health','disconnect')),
  constraint legal_source_operations_status_check
    check (status in ('dispatching','succeeded','failed')),
  constraint legal_source_operations_fingerprint_check
    check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  constraint legal_source_operations_result_check
    check (
      (status = 'dispatching' and result_payload is null and http_status is null)
      or (status <> 'dispatching' and jsonb_typeof(result_payload) = 'object' and http_status between 200 and 599)
    )
);
create index if not exists legal_source_operations_dispatch_idx
  on legal_source_operations (lease_expires_at, id) where status = 'dispatching';

create table if not exists legal_source_fragments (
  id                    bigint generated always as identity primary key,
  user_id               bigint not null references users (id) on delete cascade,
  connection_id         bigint references legal_source_connections (id) on delete cascade,
  provider_id           varchar(64) not null,
  external_id           varchar(300) not null,
  fragment_index        integer not null,
  legal_type            varchar(24) not null,
  title                 varchar(1000) not null,
  content               text not null,
  source_name           varchar(300) not null,
  source_date           timestamptz not null,
  currentness           varchar(24) not null,
  source_url            text not null,
  relevant_at           timestamptz,
  metadata              jsonb not null default '{}'::jsonb,
  synced_at             timestamptz not null default now(),
  constraint legal_source_fragments_identity_key
    unique (user_id, provider_id, external_id, fragment_index),
  constraint legal_source_fragments_index_check check (fragment_index >= 0),
  constraint legal_source_fragments_type_check
    check (legal_type in ('law','case','commentary','document')),
  constraint legal_source_fragments_currentness_check
    check (currentness in ('current','superseded','unknown')),
  constraint legal_source_fragments_content_check check (length(btrim(content)) > 0),
  constraint legal_source_fragments_source_url_check check (source_url ~ '^https://')
);
create index if not exists legal_source_fragments_lookup_idx
  on legal_source_fragments (user_id, legal_type, source_date desc, id desc);
create index if not exists legal_source_fragments_connection_idx
  on legal_source_fragments (connection_id, synced_at desc);


-- ================================================== Гибридный поиск Telegram
-- Быстрый локальный поиск остаётся основой. Сырые web-находки сохраняются отдельно,
-- проходят живую проверку публичной t.me/s-страницы и только после неё попадают в выдачу.
create table if not exists discovered_sources (
  id                  bigint generated always as identity primary key,
  network             text not null default 'tg',
  handle              text not null,
  canonical_url       text not null,
  title               text,
  description         text,
  subscribers         integer,
  last_post_at        timestamptz,
  posts_per_week      numeric(7,1),
  is_public           boolean not null default true,
  verification_status text not null default 'verified',
  provider            text not null,
  raw_data             jsonb not null default '{}'::jsonb,
  verified_at          timestamptz not null default now(),
  cache_expires_at     timestamptz not null default (now() + interval '24 hours'),
  tsv                  tsvector generated always as (
    to_tsvector('russian', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(handle, ''))
  ) stored,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint discovered_sources_network_handle_key unique (network, handle),
  constraint discovered_sources_network_check check (network in ('tg')),
  constraint discovered_sources_handle_check check (handle ~ '^[a-z][a-z0-9_]{3,31}$'),
  constraint discovered_sources_url_check check (canonical_url ~ '^https://t\.me/'),
  constraint discovered_sources_verification_check check (verification_status in ('verified','rejected','error')),
  constraint discovered_sources_raw_data_check check (jsonb_typeof(raw_data) = 'object')
);
create index if not exists discovered_sources_tsv_idx on discovered_sources using gin (tsv);
create index if not exists discovered_sources_cache_idx on discovered_sources (verification_status, cache_expires_at, verified_at desc);

-- Поиск темы по реальному содержанию публичных постов, а не только по вывеске канала.
alter table discovered_sources add column if not exists content_sample text;
alter table discovered_sources add column if not exists content_embedding vector(1024);
alter table discovered_sources add column if not exists indexed_posts_count integer not null default 0;
alter table discovered_sources add column if not exists content_indexed_at timestamptz;
alter table discovered_sources add column if not exists content_tsv tsvector
  generated always as (
    to_tsvector('russian', coalesce(title, '') || ' ' || coalesce(description, '') || ' '
      || coalesce(handle, '') || ' ' || coalesce(content_sample, ''))
  ) stored;
alter table discovered_sources drop constraint if exists discovered_sources_indexed_posts_count_check;
alter table discovered_sources add constraint discovered_sources_indexed_posts_count_check
  check (indexed_posts_count >= 0) not valid;
alter table discovered_sources validate constraint discovered_sources_indexed_posts_count_check;
create index if not exists discovered_sources_content_tsv_idx on discovered_sources using gin (content_tsv);
create index if not exists discovered_sources_content_embedding_idx
  on discovered_sources using hnsw (content_embedding vector_cosine_ops);

create table if not exists radar_search_runs (
  id                bigint generated always as identity primary key,
  user_id           bigint not null references users (id) on delete cascade,
  channel_id        bigint references channels (id) on delete cascade,
  request_key       varchar(128) not null,
  query             varchar(200) not null,
  normalized_query  varchar(200) not null,
  status            text not null default 'queued',
  stage             text not null default 'queued',
  progress          smallint not null default 0,
  provider          text,
  local_count       integer not null default 0,
  external_count    integer not null default 0,
  error_code        varchar(80),
  error_message     varchar(500),
  queue_confirmed_at timestamptz,
  cache_expires_at  timestamptz not null default (now() + interval '24 hours'),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz,
  constraint radar_search_runs_user_request_key unique (user_id, request_key),
  constraint radar_search_runs_query_check check (length(btrim(normalized_query)) between 2 and 200),
  constraint radar_search_runs_status_check check (status in ('queued','running','ready','partial','failed')),
  constraint radar_search_runs_stage_check check (stage in ('queued','discovering','verifying','ranking','ready','failed')),
  constraint radar_search_runs_progress_check check (progress between 0 and 100),
  constraint radar_search_runs_counts_check check (local_count >= 0 and external_count >= 0)
);
create index if not exists radar_search_runs_user_created_idx on radar_search_runs (user_id, created_at desc);
create index if not exists radar_search_runs_cache_idx on radar_search_runs (user_id, normalized_query, cache_expires_at desc) where status in ('ready','partial');
create index if not exists radar_search_runs_active_idx on radar_search_runs (status, updated_at) where status in ('queued','running');

create table if not exists radar_search_candidates (
  id               bigint generated always as identity primary key,
  run_id           bigint not null references radar_search_runs (id) on delete cascade,
  provider         text not null,
  raw_url          text not null,
  handle           text,
  canonical_key    text,
  verification_status text not null default 'pending',
  rejection_reason varchar(160),
  raw_data         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  verified_at      timestamptz,
  constraint radar_search_candidates_status_check check (verification_status in ('pending','verified','rejected','error')),
  constraint radar_search_candidates_raw_data_check check (jsonb_typeof(raw_data) = 'object'),
  constraint radar_search_candidates_run_key unique (run_id, canonical_key)
);
create index if not exists radar_search_candidates_run_idx on radar_search_candidates (run_id, verification_status, id);

create table if not exists radar_search_results (
  id                  bigint generated always as identity primary key,
  run_id              bigint not null references radar_search_runs (id) on delete cascade,
  user_id             bigint not null references users (id) on delete cascade,
  discovered_source_id bigint references discovered_sources (id) on delete set null,
  result_type         text not null,
  provider            text not null,
  canonical_key       text not null,
  url                 text not null,
  handle              text,
  external_id         bigint,
  title               text,
  description         text,
  text                text,
  posted_at           timestamptz,
  subscribers         integer,
  views               integer,
  reactions           integer,
  posts_per_week      numeric(7,1),
  last_post_at        timestamptz,
  relevance_score     smallint not null default 0,
  freshness_score     smallint not null default 0,
  activity_score      smallint not null default 0,
  trust_score         smallint not null default 0,
  quality_score       smallint not null default 0,
  reason              varchar(500) not null,
  verification_status text not null default 'verified',
  verified_at         timestamptz not null default now(),
  raw_data             jsonb not null default '{}'::jsonb,
  tsv                  tsvector generated always as (
    to_tsvector('russian', coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(text, '') || ' ' || coalesce(handle, ''))
  ) stored,
  created_at           timestamptz not null default now(),
  constraint radar_search_results_run_key unique (run_id, canonical_key),
  constraint radar_search_results_type_check check (result_type in ('channel','post','trend')),
  constraint radar_search_results_url_check check (url ~ '^https://t\.me/'),
  constraint radar_search_results_verification_check check (verification_status in ('verified')),
  constraint radar_search_results_scores_check check (
    relevance_score between 0 and 100 and freshness_score between 0 and 100
    and activity_score between 0 and 100 and trust_score between 0 and 100
    and quality_score between 0 and 100
  ),
  constraint radar_search_results_raw_data_check check (jsonb_typeof(raw_data) = 'object')
);
create index if not exists radar_search_results_run_score_idx on radar_search_results (run_id, result_type, quality_score desc, id);
create index if not exists radar_search_results_user_idx on radar_search_results (user_id, created_at desc);
create index if not exists radar_search_results_tsv_idx on radar_search_results using gin (tsv);

create unique index if not exists saved_posts_discovery_source_uniq
  on saved_posts (user_id, channel_id, source_url)
  where kind = 'reference' and source_url is not null;

-- ------------------------------------------------ Project workspaces and RBAC
-- Project is the collaboration/tenant boundary. user_id remains actor attribution.
create table if not exists project_members (
  project_id bigint not null references projects (id) on delete cascade,
  user_id    bigint not null references users (id) on delete cascade,
  role       text not null,
  status     text not null default 'active',
  version    bigint not null default 1,
  joined_at  timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (project_id, user_id),
  constraint project_members_role_check check (role in ('owner','author','approver','publisher')),
  constraint project_members_status_check check (status in ('active','revoked')),
  constraint project_members_version_check check (version > 0),
  constraint project_members_revocation_check check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);
create index if not exists project_members_user_active_idx
  on project_members (user_id, project_id) where status = 'active';
create index if not exists project_members_project_role_idx
  on project_members (project_id, role, user_id) where status = 'active';

-- Only a SHA-256 invitation token hash is persisted; the raw secret is never stored.
create table if not exists project_invitations (
  id                  bigint generated always as identity primary key,
  project_id          bigint not null references projects (id) on delete cascade,
  email               text not null,
  role                text not null,
  token_hash          char(64) not null unique,
  invited_by_user_id  bigint not null references users (id) on delete restrict,
  accepted_by_user_id bigint references users (id) on delete set null,
  expires_at          timestamptz not null,
  accepted_at         timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz not null default now(),
  constraint project_invitations_email_check
    check (email = lower(btrim(email)) and position('@' in email) > 1),
  constraint project_invitations_role_check check (role in ('author','approver','publisher')),
  constraint project_invitations_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint project_invitations_ttl_check check (expires_at > created_at),
  constraint project_invitations_resolution_check check (
    not (accepted_at is not null and revoked_at is not null)
    and (accepted_at is null or accepted_by_user_id is not null)
  )
);
create index if not exists project_invitations_project_pending_idx
  on project_invitations (project_id, expires_at, id)
  where accepted_at is null and revoked_at is null;
create index if not exists project_invitations_email_pending_idx
  on project_invitations (email, expires_at, id)
  where accepted_at is null and revoked_at is null;

create table if not exists user_project_preferences (
  user_id             bigint primary key references users (id) on delete cascade,
  selected_project_id bigint not null references projects (id) on delete restrict,
  updated_at          timestamptz not null default now()
);
create index if not exists user_project_preferences_project_idx
  on user_project_preferences (selected_project_id, user_id);

-- Project-scoped Telegram preferences. Rows are created lazily when a linked person
-- opens the bot menu, so existing accounts are not opted into digests by a deployment.
create table if not exists bot_notification_preferences (
  project_id                    bigint not null references projects (id) on delete cascade,
  user_id                       bigint not null references users (id) on delete cascade,
  publication_success_enabled  boolean not null default true,
  publication_failure_enabled  boolean not null default true,
  content_opportunities_enabled boolean not null default true,
  daily_digest_enabled         boolean not null default true,
  daily_digest_hour            smallint not null default 9 check (daily_digest_hour between 0 and 23),
  weekly_digest_enabled        boolean not null default true,
  last_daily_digest_date       date,
  last_weekly_digest_date      date,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  primary key (project_id, user_id),
  foreign key (project_id, user_id)
    references project_members (project_id, user_id) on delete cascade
);
create index if not exists bot_notification_preferences_daily_idx
  on bot_notification_preferences (daily_digest_enabled, daily_digest_hour, project_id, user_id);

alter table bot_notification_preferences
  add column if not exists post_results_enabled boolean not null default true,
  add column if not exists review_reminders_enabled boolean not null default true,
  add column if not exists problem_digest_enabled boolean not null default true;

create table if not exists bot_post_result_notifications (
  post_id       bigint not null references posts (id) on delete cascade,
  project_id    bigint not null references projects (id) on delete cascade,
  user_id       bigint not null references users (id) on delete cascade,
  window_hours  smallint not null default 24 check (window_hours between 24 and 168),
  delivered_at  timestamptz,
  created_at    timestamptz not null default now(),
  primary key (post_id, user_id, window_hours),
  foreign key (project_id, user_id)
    references project_members (project_id, user_id) on delete cascade
);
create index if not exists bot_post_result_notifications_pending_idx
  on bot_post_result_notifications (created_at, post_id) where delivered_at is null;

create table if not exists bot_client_assistant_preferences (
  project_id        bigint primary key references projects (id) on delete cascade,
  business_connection_id text unique,
  enabled           boolean not null default false,
  require_approval  boolean not null default true check (require_approval = true),
  welcome_text      text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint bot_client_assistant_welcome_check
    check (welcome_text is null or length(btrim(welcome_text)) between 1 and 1200)
);

create table if not exists bot_client_inquiries (
  id                              bigint generated always as identity primary key,
  project_id                      bigint not null references projects (id) on delete cascade,
  business_connection_id          text,
  external_chat_id                bigint,
  external_message_id             bigint,
  sender_external_id              bigint,
  incoming_text                   text not null,
  suggested_reply                 text,
  request_key                     varchar(128),
  source_type                     text not null default 'telegram_business',
  source_label                    varchar(200),
  source_url                      text,
  context                         text,
  author_name                     varchar(200),
  reply_guidance                  text,
  tone                            text,
  risk_level                      text,
  created_by_user_id              bigint references users (id) on delete set null,
  version                         bigint not null default 1,
  delivery_request_key            varchar(128),
  provider_started_at             timestamptz,
  sent_external_message_id        bigint,
  delivery_error_code             varchar(80),
  status                          text not null default 'pending',
  resolved_by_user_id             bigint references users (id) on delete set null,
  resolved_at                     timestamptz,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  constraint bot_client_inquiries_text_check check (length(btrim(incoming_text)) between 1 and 8000),
  constraint bot_client_inquiries_reply_check check (suggested_reply is null or length(btrim(suggested_reply)) between 1 and 8000),
  constraint bot_client_inquiries_status_check
    check (status in ('pending','reply_ready','approved','sent','dismissed','failed')),
  constraint bot_client_inquiries_source_type_check
    check (source_type in ('telegram_business','comment','direct_message','support','review','other')),
  constraint bot_client_inquiries_request_key_check
    check (request_key is null or length(btrim(request_key)) between 16 and 128),
  constraint bot_client_inquiries_source_label_check
    check (source_label is null or length(btrim(source_label)) between 1 and 200),
  constraint bot_client_inquiries_context_check
    check (context is null or length(btrim(context)) between 1 and 4000),
  constraint bot_client_inquiries_author_name_check
    check (author_name is null or length(btrim(author_name)) between 1 and 200),
  constraint bot_client_inquiries_guidance_check
    check (reply_guidance is null or length(btrim(reply_guidance)) between 1 and 2000),
  constraint bot_client_inquiries_tone_check
    check (tone is null or tone in ('positive','neutral','negative','aggressive')),
  constraint bot_client_inquiries_risk_check
    check (risk_level is null or risk_level in ('low','medium','high')),
  constraint bot_client_inquiries_version_check check (version > 0),
  constraint bot_client_inquiries_delivery_coordinates_check check (
    source_type <> 'telegram_business'
    or (business_connection_id is not null and external_chat_id is not null and external_message_id is not null)
  ),
  constraint bot_client_inquiries_delivery_request_key_check
    check (delivery_request_key is null or length(btrim(delivery_request_key)) between 16 and 128),
  constraint bot_client_inquiries_delivery_error_code_check
    check (delivery_error_code is null or length(btrim(delivery_error_code)) between 1 and 80),
  unique (business_connection_id, external_chat_id, external_message_id)
);
create index if not exists bot_client_inquiries_project_status_idx
  on bot_client_inquiries (project_id, status, created_at, id);
create unique index if not exists bot_client_inquiries_project_request_key_uniq
  on bot_client_inquiries (project_id, request_key) where request_key is not null;
create index if not exists bot_client_inquiries_project_updated_idx
  on bot_client_inquiries (project_id, updated_at desc, id desc);
create unique index if not exists bot_client_inquiries_project_delivery_request_uniq
  on bot_client_inquiries (project_id, delivery_request_key)
  where delivery_request_key is not null;
create index if not exists bot_client_inquiries_stale_delivery_idx
  on bot_client_inquiries (provider_started_at, id)
  where status = 'approved';

create table if not exists bot_user_controls (
  user_id             bigint primary key references users (id) on delete cascade,
  enabled             boolean not null default true,
  disabled_reason     varchar(500),
  updated_by_user_id  bigint references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint bot_user_controls_reason_check check (
    (enabled = true and disabled_reason is null)
    or (enabled = false and length(btrim(disabled_reason)) between 3 and 500)
  )
);

create table if not exists bot_project_controls (
  project_id          bigint primary key references projects (id) on delete cascade,
  enabled             boolean not null default true,
  disabled_reason     varchar(500),
  updated_by_user_id  bigint references users (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint bot_project_controls_reason_check check (
    (enabled = true and disabled_reason is null)
    or (enabled = false and length(btrim(disabled_reason)) between 3 and 500)
  )
);

create table if not exists bot_delivery_events (
  id                   bigint generated always as identity primary key,
  user_id              bigint references users (id) on delete set null,
  project_id           bigint references projects (id) on delete set null,
  chat_id              bigint,
  method               varchar(64) not null,
  source               varchar(80) not null default 'assistant',
  ok                   boolean not null,
  telegram_error_code  integer,
  error_code           varchar(100),
  error_description    varchar(500),
  created_at           timestamptz not null default now(),
  constraint bot_delivery_events_method_check check (length(btrim(method)) between 1 and 64),
  constraint bot_delivery_events_source_check check (length(btrim(source)) between 1 and 80),
  constraint bot_delivery_events_error_check check (
    (ok = true and error_code is null and error_description is null) or ok = false
  )
);
create index if not exists bot_delivery_events_created_idx
  on bot_delivery_events (created_at desc, id desc);
create index if not exists bot_delivery_events_failure_idx
  on bot_delivery_events (created_at desc, id desc) where ok = false;
create index if not exists bot_delivery_events_user_idx
  on bot_delivery_events (user_id, created_at desc, id desc) where user_id is not null;

create table if not exists bot_interaction_events (
  id                  bigint generated always as identity primary key,
  telegram_update_id  bigint not null unique,
  user_id             bigint references users (id) on delete set null,
  project_id          bigint references projects (id) on delete set null,
  interaction_type    varchar(24) not null,
  action              varchar(100) not null,
  created_at          timestamptz not null default now(),
  constraint bot_interaction_events_update_check check (telegram_update_id >= 0),
  constraint bot_interaction_events_type_check check (
    interaction_type in ('command','reply_button','callback','message','voice','attachment')
  ),
  constraint bot_interaction_events_action_check check (length(btrim(action)) between 1 and 100)
);
create index if not exists bot_interaction_events_created_idx
  on bot_interaction_events (created_at desc, id desc);
create index if not exists bot_interaction_events_user_idx
  on bot_interaction_events (user_id, created_at desc, id desc) where user_id is not null;
create index if not exists bot_interaction_events_project_idx
  on bot_interaction_events (project_id, created_at desc, id desc) where project_id is not null;

create table if not exists bot_admin_action_events (
  id             bigint generated always as identity primary key,
  actor_user_id  bigint references users (id) on delete set null,
  action         varchar(100) not null,
  target_type    varchar(40) not null,
  target_id      bigint,
  safe_data      jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  constraint bot_admin_action_events_action_check check (length(btrim(action)) between 1 and 100),
  constraint bot_admin_action_events_target_check check (target_type in ('user','project','runtime')),
  constraint bot_admin_action_events_target_id_check check (
    (target_type = 'runtime' and target_id is null)
    or (target_type in ('user','project') and target_id > 0)
  ),
  constraint bot_admin_action_events_safe_data_check check (jsonb_typeof(safe_data) = 'object')
);
create index if not exists bot_admin_action_events_created_idx
  on bot_admin_action_events (created_at desc, id desc);

create table if not exists audit_events (
  id              bigint generated always as identity primary key,
  project_id      bigint not null references projects (id) on delete restrict,
  actor_user_id   bigint references users (id) on delete set null,
  action          varchar(100) not null,
  entity_type     varchar(80) not null,
  entity_id       text,
  before_version  bigint,
  after_version   bigint,
  safe_data       jsonb not null default '{}'::jsonb,
  request_id      varchar(128),
  idempotency_key varchar(160),
  created_at      timestamptz not null default now(),
  constraint audit_events_action_check check (length(btrim(action)) between 1 and 100),
  constraint audit_events_entity_type_check check (length(btrim(entity_type)) between 1 and 80),
  constraint audit_events_versions_check check (
    (before_version is null or before_version > 0)
    and (after_version is null or after_version > 0)
  ),
  constraint audit_events_safe_data_check check (jsonb_typeof(safe_data) = 'object')
);
create index if not exists audit_events_project_created_idx
  on audit_events (project_id, created_at desc, id desc);
create unique index if not exists audit_events_project_idempotency_uniq
  on audit_events (project_id, idempotency_key) where idempotency_key is not null;

insert into projects (name, timezone, created_by_user_id, personal_owner_user_id, created_at, updated_at)
select 'Личный проект', 'UTC', users.id, users.id, now(), now() from users
on conflict (personal_owner_user_id) do nothing;
insert into project_members (project_id, user_id, role, status, joined_at, updated_at)
select projects.id, projects.personal_owner_user_id, 'owner', 'active', projects.created_at, projects.created_at
  from projects where projects.personal_owner_user_id is not null
on conflict (project_id, user_id) do nothing;
insert into user_project_preferences (user_id, selected_project_id)
select projects.personal_owner_user_id, projects.id
  from projects where projects.personal_owner_user_id is not null
on conflict (user_id) do nothing;
insert into audit_events (
  project_id, actor_user_id, action, entity_type, entity_id,
  after_version, safe_data, idempotency_key, created_at
)
select projects.id, projects.personal_owner_user_id, 'project.created', 'project', projects.id::text,
       projects.version, jsonb_build_object('kind', 'personal', 'source', 'legacy_backfill'),
       'bootstrap:personal-project:' || projects.id::text, projects.created_at
  from projects where projects.personal_owner_user_id is not null
on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing;

create or replace function aurora_selected_project_for_user(target_user_id bigint)
returns bigint language sql stable as $$
  select coalesce(
    (select preference.selected_project_id
       from user_project_preferences preference
       join project_members member
         on member.project_id = preference.selected_project_id
        and member.user_id = preference.user_id and member.status = 'active'
       join projects project on project.id = preference.selected_project_id
      where preference.user_id = target_user_id and project.is_archived = false limit 1),
    (select project.id
       from projects project
       join project_members member
         on member.project_id = project.id
        and member.user_id = target_user_id and member.status = 'active'
      where project.personal_owner_user_id = target_user_id and project.is_archived = false limit 1)
  )
$$;

create or replace function aurora_assign_user_project()
returns trigger language plpgsql as $$
begin
  if new.project_id is null then new.project_id := aurora_selected_project_for_user(new.user_id); end if;
  if new.project_id is null then raise exception 'project_context_missing' using errcode = '23514'; end if;
  return new;
end
$$;

-- Composite project foreign keys used by the feature tables below require the
-- tenant columns and matching unique keys to exist during a fresh bootstrap.
-- The later project-context section remains idempotent for legacy backfills.
alter table channels add column if not exists project_id bigint references projects (id) on delete restrict;
update channels channel set project_id = project.id from projects project
 where channel.project_id is null and project.personal_owner_user_id = channel.user_id;
alter table channels alter column project_id set not null;

alter table drafts add column if not exists project_id bigint references projects (id) on delete restrict;
update drafts draft set project_id = project.id from projects project
 where draft.project_id is null and project.personal_owner_user_id = draft.user_id;
alter table drafts alter column project_id set not null;

alter table posts add column if not exists project_id bigint references projects (id) on delete restrict;
update posts post set project_id = coalesce(
  (select channel.project_id from channels channel where channel.id = post.channel_id),
  (select project.id from projects project where project.personal_owner_user_id = post.user_id)
) where post.project_id is null;
alter table posts alter column project_id set not null;

alter table publication_operations add column if not exists project_id bigint references projects (id) on delete restrict;
update publication_operations operation set project_id = coalesce(
  (select draft.project_id from drafts draft where draft.id = operation.draft_id),
  (select project.id from projects project where project.personal_owner_user_id = operation.user_id)
) where operation.project_id is null;
alter table publication_operations alter column project_id set not null;

create unique index if not exists channels_id_project_uniq on channels (id, project_id);
create unique index if not exists drafts_id_project_uniq on drafts (id, project_id);
create unique index if not exists posts_id_project_uniq on posts (id, project_id);
create unique index if not exists publication_operations_id_project_uniq
  on publication_operations (id, project_id);

-- Durable one-at-a-time Telegram composer. Its composite tenant keys require the
-- project columns and unique keys above to exist first on a fresh bootstrap.
create table if not exists bot_conversations (
  id          bigint generated always as identity primary key,
  user_id     bigint not null unique references users (id) on delete cascade,
  project_id  bigint not null references projects (id) on delete cascade,
  channel_id  bigint,
  draft_id    bigint,
  state       text not null check (
    state in ('choosing_channel','waiting_text','preview','improving','publishing','review_changes','completed','cancelled')
  ),
  token       varchar(24) not null check (token ~ '^[A-Za-z0-9_-]{16,24}$'),
  data        jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object'),
  expires_at  timestamptz not null default (now() + interval '24 hours'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade,
  foreign key (draft_id, project_id) references drafts (id, project_id) on delete cascade
);
create index if not exists bot_conversations_expiry_idx
  on bot_conversations (expires_at, id);

-- ------------------------------------------------ Publication blocks, follow-up actions and review tasks

create table if not exists project_publication_blocks (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  kind               text not null,
  name               varchar(120) not null,
  body               text not null,
  version            bigint not null default 1,
  is_enabled         boolean not null default true,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint project_publication_blocks_kind_check check (
    kind in ('author_signature','contacts','disclaimer','cta','sources','first_comment')
  ),
  constraint project_publication_blocks_name_check check (length(btrim(name)) between 1 and 120),
  constraint project_publication_blocks_body_check check (length(btrim(body)) between 1 and 2000),
  constraint project_publication_blocks_version_check check (version > 0),
  unique (id, project_id)
);
create index if not exists project_publication_blocks_project_kind_idx
  on project_publication_blocks (project_id, kind, is_enabled desc, id);

create table if not exists draft_publication_preferences (
  draft_id                    bigint primary key,
  project_id                  bigint not null references projects (id) on delete cascade,
  selected_block_ids          jsonb not null default '[]'::jsonb,
  first_comment_fallback      text not null default 'skip',
  comments_mode               text not null default 'provider_default',
  pin_after_publish           boolean not null default false,
  review_at                   timestamptz,
  review_responsible_user_id  bigint references users (id) on delete set null,
  version                     bigint not null default 1,
  updated_by_user_id          bigint not null references users (id) on delete restrict,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  constraint draft_publication_preferences_draft_project_fk foreign key (draft_id, project_id)
    references drafts (id, project_id) on delete cascade,
  constraint draft_publication_preferences_blocks_check check (jsonb_typeof(selected_block_ids) = 'array'),
  constraint draft_publication_preferences_fallback_check check (
    first_comment_fallback in ('append_to_post','skip')
  ),
  constraint draft_publication_preferences_comments_check check (
    comments_mode in ('provider_default','enabled','disabled')
  ),
  constraint draft_publication_preferences_review_check check (
    (review_at is null and review_responsible_user_id is null)
    or (review_at is not null and review_responsible_user_id is not null)
  ),
  constraint draft_publication_preferences_version_check check (version > 0),
  unique (draft_id, project_id)
);
create index if not exists draft_publication_preferences_project_review_idx
  on draft_publication_preferences (project_id, review_at, draft_id)
  where review_at is not null;

create table if not exists publication_extra_operations (
  id                       bigint generated always as identity primary key,
  project_id               bigint not null references projects (id) on delete cascade,
  publication_operation_id bigint references publication_operations (id) on delete cascade,
  post_id                  bigint not null,
  channel_id               bigint not null,
  kind                     text not null,
  sequence_index           smallint not null,
  idempotency_key          varchar(160) not null,
  fingerprint              char(64) not null,
  request_snapshot         jsonb not null,
  status                   text not null default 'pending',
  external_id              text,
  external_url             text,
  attempts                 integer not null default 0,
  next_attempt_at          timestamptz not null default now(),
  last_error_code          text,
  last_error_message       text,
  lease_token              char(64),
  lease_expires_at         timestamptz,
  provider_started_at      timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint publication_extra_operations_post_project_fk foreign key (post_id, project_id)
    references posts (id, project_id) on delete cascade,
  constraint publication_extra_operations_channel_project_fk foreign key (channel_id, project_id)
    references channels (id, project_id) on delete cascade,
  constraint publication_extra_operations_operation_project_fk
    foreign key (publication_operation_id, project_id)
    references publication_operations (id, project_id) on delete cascade,
  constraint publication_extra_operations_kind_check check (
    kind in ('first_comment','configure_comments','pin','unpin')
  ),
  constraint publication_extra_operations_sequence_check check (sequence_index between 1 and 100),
  constraint publication_extra_operations_fingerprint_check check (fingerprint ~ '^[0-9a-f]{64}$'),
  constraint publication_extra_operations_snapshot_check check (jsonb_typeof(request_snapshot) = 'object'),
  constraint publication_extra_operations_status_check check (
    status in ('pending','dispatching','queued','running','waiting_dependency',
               'succeeded','failed_retry','failed','skipped','unsupported','cancelled')
  ),
  constraint publication_extra_operations_attempts_check check (attempts >= 0),
  constraint publication_extra_operations_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  unique (project_id, idempotency_key),
  unique (id, project_id)
);
create index if not exists publication_extra_operations_post_idx
  on publication_extra_operations (project_id, post_id, kind, id);
create index if not exists publication_extra_operations_due_idx
  on publication_extra_operations (next_attempt_at, id)
  where status in ('pending','failed_retry','waiting_dependency');

-- Historical migration 20260816 originally installed this key. Multiple operations
-- of the same kind may share one dependency position, so the later repair removes it.
alter table publication_extra_operations
  drop constraint if exists publication_extra_operations_project_id_post_id_sequence_in_key;

create table if not exists publication_extra_attempts (
  id              bigint generated always as identity primary key,
  project_id      bigint not null references projects (id) on delete cascade,
  operation_id    bigint not null,
  attempt_number  integer not null,
  status          text not null,
  safe_error_code varchar(100),
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  constraint publication_extra_attempts_operation_project_fk
    foreign key (operation_id, project_id)
    references publication_extra_operations (id, project_id) on delete cascade,
  constraint publication_extra_attempts_number_check check (attempt_number > 0),
  constraint publication_extra_attempts_status_check
    check (status in ('running','succeeded','failed_retry','failed')),
  constraint publication_extra_attempts_error_check
    check (safe_error_code is null or safe_error_code ~ '^[a-z0-9_]{1,100}$'),
  constraint publication_extra_attempts_completion_check check (
    (status = 'running' and completed_at is null)
    or (status <> 'running' and completed_at is not null)
  ),
  unique (operation_id, attempt_number)
);
create index if not exists publication_extra_attempts_project_operation_idx
  on publication_extra_attempts (project_id, operation_id, attempt_number);

create table if not exists publication_extra_outbox (
  id                bigint generated always as identity primary key,
  project_id        bigint not null references projects (id) on delete cascade,
  operation_id      bigint not null,
  status            text not null default 'pending',
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  last_error_code   text,
  lease_token       char(64),
  lease_expires_at  timestamptz,
  enqueued_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint publication_extra_outbox_operation_project_fk foreign key (operation_id, project_id)
    references publication_extra_operations (id, project_id) on delete cascade,
  constraint publication_extra_outbox_status_check check (
    status in ('pending','dispatching','enqueued','failed','completed','cancelled')
  ),
  constraint publication_extra_outbox_attempts_check check (attempts >= 0),
  constraint publication_extra_outbox_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  unique (project_id, operation_id)
);
create index if not exists publication_extra_outbox_due_idx
  on publication_extra_outbox (next_attempt_at, id)
  where status in ('pending','failed');

create table if not exists telegram_discussion_messages (
  id                    bigint generated always as identity primary key,
  project_id            bigint not null references projects (id) on delete cascade,
  channel_id            bigint not null,
  post_id               bigint,
  origin_chat_id        bigint not null,
  origin_message_id     bigint not null,
  discussion_chat_id    bigint not null,
  discussion_message_id bigint not null,
  observed_at           timestamptz not null default now(),
  constraint telegram_discussion_messages_channel_project_fk foreign key (channel_id, project_id)
    references channels (id, project_id) on delete cascade,
  constraint telegram_discussion_messages_post_project_fk foreign key (post_id, project_id)
    references posts (id, project_id) on delete cascade,
  unique (channel_id, origin_message_id),
  unique (discussion_chat_id, discussion_message_id)
);
create index if not exists telegram_discussion_messages_post_idx
  on telegram_discussion_messages (project_id, post_id)
  where post_id is not null;

create table if not exists publication_review_tasks (
  id                    bigint generated always as identity primary key,
  project_id            bigint not null references projects (id) on delete cascade,
  post_id               bigint not null,
  responsible_user_id   bigint not null references users (id) on delete restrict,
  review_at             timestamptz not null,
  timezone              varchar(80) not null,
  status                text not null default 'scheduled',
  decision              text,
  decision_note         text,
  decided_by_user_id    bigint references users (id) on delete set null,
  decided_at            timestamptz,
  reminder_idempotency_key varchar(160) not null,
  reminder_status       text not null default 'pending',
  reminder_sent_at      timestamptz,
  version               bigint not null default 1,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint publication_review_tasks_post_project_fk foreign key (post_id, project_id)
    references posts (id, project_id) on delete cascade,
  constraint publication_review_tasks_timezone_check check (length(btrim(timezone)) between 1 and 80),
  constraint publication_review_tasks_status_check check (status in ('scheduled','due','completed','cancelled')),
  constraint publication_review_tasks_decision_check check (
    decision is null or decision in ('keep','update','unpin','remove_manually')
  ),
  constraint publication_review_tasks_resolution_check check (
    (status in ('scheduled','due') and decision is null and decided_by_user_id is null and decided_at is null)
    or (status = 'completed' and decision is not null and decided_by_user_id is not null and decided_at is not null)
    or (status = 'cancelled' and decision is null and decided_by_user_id is null and decided_at is null)
  ),
  constraint publication_review_tasks_reminder_status_check check (
    reminder_status in ('pending','sending','sent','failed','cancelled')
  ),
  constraint publication_review_tasks_version_check check (version > 0),
  unique (project_id, reminder_idempotency_key),
  unique (id, project_id)
);
create index if not exists publication_review_tasks_due_idx
  on publication_review_tasks (review_at, id)
  where status = 'scheduled';
create index if not exists publication_review_tasks_assignee_idx
  on publication_review_tasks (project_id, responsible_user_id, status, review_at);

-- ------------------------------------------------ Project tracking and protected exports

-- Project-owned UTM presets. UTM values are validated again in application code;
-- the database keeps only normalized structured values, never arbitrary query blobs.
create table if not exists project_utm_templates (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  name               varchar(120) not null,
  values             jsonb not null default '{}'::jsonb,
  version            bigint not null default 1,
  is_archived        boolean not null default false,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint project_utm_templates_name_check check (length(btrim(name)) between 1 and 120),
  constraint project_utm_templates_values_check check (jsonb_typeof(values) = 'object'),
  constraint project_utm_templates_version_check check (version > 0),
  unique (id, project_id)
);
create unique index if not exists project_utm_templates_active_name_uniq
  on project_utm_templates (project_id, lower(btrim(name))) where is_archived = false;
create index if not exists project_utm_templates_project_idx
  on project_utm_templates (project_id, is_archived, updated_at desc, id desc);

-- Explicit readiness prevents a real zero from being confused with an absent
-- first-party tracker. No script token or personal data is stored here.
create table if not exists project_tracking_settings (
  project_id             bigint primary key references projects (id) on delete cascade,
  status                 text not null default 'not_connected',
  site_origin            text,
  public_key             varchar(64) unique,
  attribution_window_days smallint not null default 30,
  version                bigint not null default 1,
  updated_by_user_id     bigint references users (id) on delete set null,
  verified_at            timestamptz,
  last_ping_at           timestamptz,
  verification_challenge varchar(160),
  signal_received_at     timestamptz,
  verification_checked_at timestamptz,
  verification_error_code varchar(100),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint project_tracking_settings_status_check
    check (status in ('not_connected','pending_verification','active','paused','verification_failed')),
  constraint project_tracking_settings_origin_check
    check (site_origin is null or site_origin ~ '^https?://[^/?#]+$'),
  constraint project_tracking_settings_public_key_check
    check (public_key is null or public_key ~ '^[A-Za-z0-9_-]{20,64}$'),
  constraint project_tracking_settings_window_check check (attribution_window_days between 1 and 90),
  constraint project_tracking_settings_version_check check (version > 0),
  constraint project_tracking_settings_challenge_check check (
    verification_challenge is null
    or verification_challenge ~ '^aurora-site-verification=[A-Za-z0-9_-]{32,128}$'
  ),
  constraint project_tracking_settings_verification_error_check check (
    verification_error_code is null or verification_error_code ~ '^[a-z0-9_]{1,100}$'
  ),
  constraint project_tracking_settings_readiness_check check (
    (status = 'active' and site_origin is not null and public_key is not null
      and verification_challenge is not null and verified_at is not null
      and verification_checked_at is not null and verification_error_code is null)
    or status <> 'active'
  )
);

-- The destination is server-owned after creation. The public redirect resolves a
-- random slug only; a request can never supply a destination at redirect time.
create table if not exists short_links (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  created_by_user_id bigint not null references users (id) on delete restrict,
  request_key        varchar(128) not null,
  request_hash       char(64) not null,
  template_id        bigint,
  slug               varchar(64) not null unique,
  destination_url    text not null,
  destination_hash   char(64) not null,
  utm_values         jsonb not null default '{}'::jsonb,
  status             text not null default 'active',
  version            bigint not null default 1,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint short_links_slug_check check (slug ~ '^[A-Za-z0-9_-]{20,64}$'),
  constraint short_links_request_key_check check (length(btrim(request_key)) between 8 and 128),
  constraint short_links_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint short_links_destination_check check (destination_url ~ '^https?://'),
  constraint short_links_destination_hash_check check (destination_hash ~ '^[0-9a-f]{64}$'),
  constraint short_links_utm_check check (jsonb_typeof(utm_values) = 'object'),
  constraint short_links_status_check check (status in ('active','revoked','expired')),
  constraint short_links_version_check check (version > 0),
  constraint short_links_revocation_check check (
    (status = 'revoked' and revoked_at is not null)
    or (status <> 'revoked' and revoked_at is null)
  ),
  constraint short_links_template_project_fk foreign key (template_id, project_id)
    references project_utm_templates (id, project_id) on delete restrict,
  unique (project_id, created_by_user_id, request_key),
  unique (id, project_id)
);
create index if not exists short_links_project_created_idx
  on short_links (project_id, created_at desc, id desc);
create index if not exists short_links_active_expiry_idx
  on short_links (expires_at, id) where status = 'active';

-- One row per short-link/day fingerprint provides an exact unique denominator
-- while the click ledger below still records every visit.
create table if not exists short_link_unique_visitors (
  project_id      bigint not null references projects (id) on delete cascade,
  short_link_id   bigint not null references short_links (id) on delete cascade,
  dedupe_key      char(64) not null,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  primary key (short_link_id, dedupe_key),
  constraint short_link_unique_visitors_key_check check (dedupe_key ~ '^[0-9a-f]{64}$'),
  constraint short_link_unique_visitors_link_project_fk foreign key (short_link_id, project_id)
    references short_links (id, project_id) on delete cascade
);
create index if not exists short_link_unique_visitors_project_idx
  on short_link_unique_visitors (project_id, first_seen_at desc, short_link_id);

-- No raw IP address or complete user-agent string is retained. visitor_hash and
-- dedupe_key are keyed hashes produced by the server and cannot be reversed.
create table if not exists short_link_clicks (
  id                  uuid primary key default gen_random_uuid(),
  project_id          bigint not null references projects (id) on delete cascade,
  short_link_id       bigint not null references short_links (id) on delete cascade,
  visitor_hash        char(64) not null,
  dedupe_key          char(64) not null,
  is_unique           boolean not null,
  is_likely_bot       boolean not null default false,
  client_class        varchar(40) not null default 'browser',
  referrer_host       varchar(253),
  occurred_at         timestamptz not null default now(),
  attribution_expires_at timestamptz not null,
  constraint short_link_clicks_visitor_hash_check check (visitor_hash ~ '^[0-9a-f]{64}$'),
  constraint short_link_clicks_dedupe_key_check check (dedupe_key ~ '^[0-9a-f]{64}$'),
  constraint short_link_clicks_client_class_check
    check (client_class in ('browser','preview','crawler','unknown')),
  constraint short_link_clicks_referrer_check
    check (referrer_host is null or length(referrer_host) between 1 and 253),
  constraint short_link_clicks_attribution_check check (attribution_expires_at > occurred_at),
  constraint short_link_clicks_link_project_fk foreign key (short_link_id, project_id)
    references short_links (id, project_id) on delete cascade,
  unique (id, short_link_id, project_id)
);
create index if not exists short_link_clicks_project_time_idx
  on short_link_clicks (project_id, occurred_at desc, id);
create index if not exists short_link_clicks_link_time_idx
  on short_link_clicks (short_link_id, occurred_at desc, id);
create index if not exists short_link_clicks_human_idx
  on short_link_clicks (project_id, short_link_id, occurred_at desc)
  where is_likely_bot = false;

-- Only events with a valid signed attribution token are inserted. Repeating the
-- same first-party event with one idempotency key returns the stored result.
create table if not exists conversion_events (
  id                    uuid primary key default gen_random_uuid(),
  project_id            bigint not null references projects (id) on delete cascade,
  short_link_id         bigint not null references short_links (id) on delete cascade,
  click_id              uuid not null references short_link_clicks (id) on delete restrict,
  event_type            text not null,
  idempotency_hash      char(64) not null,
  request_hash          char(64) not null,
  attribution_token_hash char(64) not null,
  occurred_at           timestamptz not null,
  received_at           timestamptz not null default now(),
  safe_properties       jsonb not null default '{}'::jsonb,
  constraint conversion_events_type_check
    check (event_type in ('form_open','form_submit','consultation_booked')),
  constraint conversion_events_idempotency_hash_check check (idempotency_hash ~ '^[0-9a-f]{64}$'),
  constraint conversion_events_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint conversion_events_token_hash_check check (attribution_token_hash ~ '^[0-9a-f]{64}$'),
  constraint conversion_events_properties_check check (jsonb_typeof(safe_properties) = 'object'),
  constraint conversion_events_clock_check check (occurred_at <= received_at + interval '5 minutes'),
  constraint conversion_events_link_project_fk foreign key (short_link_id, project_id)
    references short_links (id, project_id) on delete cascade,
  constraint conversion_events_click_link_project_fk foreign key (click_id, short_link_id, project_id)
    references short_link_clicks (id, short_link_id, project_id) on delete restrict,
  unique (project_id, idempotency_hash)
);
create index if not exists conversion_events_project_time_idx
  on conversion_events (project_id, occurred_at desc, id);
create index if not exists conversion_events_link_time_idx
  on conversion_events (short_link_id, occurred_at desc, id);

-- Exact tracking configuration used for one publication revision. It is immutable
-- application evidence just like publication text/media snapshots.
create unique index if not exists publication_operations_id_project_uniq
  on publication_operations (id, project_id);
create unique index if not exists posts_id_project_uniq on posts (id, project_id);
create table if not exists publication_tracking_snapshots (
  id                       bigint generated always as identity primary key,
  project_id               bigint not null references projects (id) on delete restrict,
  publication_operation_id bigint not null references publication_operations (id) on delete cascade,
  post_id                  bigint not null references posts (id) on delete cascade,
  short_link_id            bigint,
  placement                varchar(80) not null,
  destination_url          text not null,
  short_url_path           varchar(80),
  utm_values               jsonb not null default '{}'::jsonb,
  snapshot_hash            char(64) not null,
  created_at               timestamptz not null default now(),
  constraint publication_tracking_placement_check check (length(btrim(placement)) between 1 and 80),
  constraint publication_tracking_destination_check check (destination_url ~ '^https?://'),
  constraint publication_tracking_short_path_check
    check (short_url_path is null or short_url_path ~ '^/r/[A-Za-z0-9_-]{20,64}$'),
  constraint publication_tracking_utm_check check (jsonb_typeof(utm_values) = 'object'),
  constraint publication_tracking_hash_check check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  constraint publication_tracking_operation_project_fk foreign key (publication_operation_id, project_id)
    references publication_operations (id, project_id) on delete cascade,
  constraint publication_tracking_post_project_fk foreign key (post_id, project_id)
    references posts (id, project_id) on delete cascade,
  constraint publication_tracking_link_project_fk foreign key (short_link_id, project_id)
    references short_links (id, project_id) on delete restrict,
  unique (post_id, placement)
);
create index if not exists publication_tracking_project_idx
  on publication_tracking_snapshots (project_id, created_at desc, id desc);
create index if not exists publication_tracking_operation_idx
  on publication_tracking_snapshots (publication_operation_id, post_id, placement);

-- Composer persists the structured tracking choice with the editable draft. The
-- editorial revision builder hashes this field, so changing a link invalidates an
-- earlier approval exactly like changing the text.
alter table drafts add column if not exists tracking jsonb not null default '{}'::jsonb;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'drafts_tracking_object_check'
  ) then
    alter table drafts add constraint drafts_tracking_object_check
      check (jsonb_typeof(tracking) = 'object');
  end if;
end
$$;

-- Large project exports use a durable outbox and a short-lived, hashed download
-- token. The immutable snapshot is shared by CSV, XLSX and PDF renderers.
create table if not exists project_export_operations (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  requested_by_user_id bigint not null references users (id) on delete restrict,
  export_kind        text not null,
  format             text not null,
  request_key        varchar(128) not null,
  request_hash       char(64) not null,
  filters            jsonb not null default '{}'::jsonb,
  snapshot           jsonb not null,
  snapshot_hash      char(64) not null,
  status             text not null default 'pending',
  error_code         varchar(100),
  error_message      varchar(500),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  completed_at       timestamptz,
  constraint project_export_operations_kind_check check (export_kind in ('content_plan','analytics')),
  constraint project_export_operations_format_check check (format in ('csv','xlsx','pdf')),
  constraint project_export_operations_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint project_export_operations_filters_check check (jsonb_typeof(filters) = 'object'),
  constraint project_export_operations_snapshot_check check (jsonb_typeof(snapshot) = 'object'),
  constraint project_export_operations_snapshot_hash_check check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  constraint project_export_operations_status_check
    check (status in ('pending','queued','rendering','ready','retryable_failed','failed','expired')),
  unique (project_id, requested_by_user_id, request_key),
  unique (id, project_id)
);
create index if not exists project_export_operations_project_idx
  on project_export_operations (project_id, created_at desc, id desc);
create index if not exists project_export_operations_active_idx
  on project_export_operations (status, updated_at, id)
  where status in ('pending','queued','rendering','retryable_failed');

create table if not exists project_export_artifacts (
  id                 bigint generated always as identity primary key,
  operation_id       bigint not null unique references project_export_operations (id) on delete cascade,
  project_id         bigint not null references projects (id) on delete cascade,
  file_name          varchar(240) not null,
  mime_type          varchar(120) not null,
  byte_size          bigint not null,
  sha256             char(64) not null,
  storage_backend    text not null default 'postgres',
  data               bytea,
  object_key         text,
  object_etag        text,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default (now() + interval '24 hours'),
  constraint project_export_artifacts_size_check check (byte_size >= 0),
  constraint project_export_artifacts_hash_check check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint project_export_artifacts_storage_check check (storage_backend in ('postgres','object')),
  constraint project_export_artifacts_payload_check check (
    (storage_backend = 'postgres' and data is not null and object_key is null)
    or (storage_backend = 'object' and data is null and object_key is not null)
  ),
  constraint project_export_artifacts_expiry_check check (expires_at > created_at),
  constraint project_export_artifacts_operation_project_fk foreign key (operation_id, project_id)
    references project_export_operations (id, project_id) on delete cascade,
  unique (id, project_id)
);
create index if not exists project_export_artifacts_expiry_idx
  on project_export_artifacts (expires_at, id);
create unique index if not exists project_export_artifacts_object_key_uniq
  on project_export_artifacts (object_key) where object_key is not null;

create table if not exists project_export_download_tokens (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  artifact_id        bigint not null references project_export_artifacts (id) on delete cascade,
  requested_by_user_id bigint not null references users (id) on delete cascade,
  token_hash         char(64) not null unique,
  expires_at         timestamptz not null,
  revoked_at         timestamptz,
  last_downloaded_at timestamptz,
  created_at         timestamptz not null default now(),
  constraint project_export_download_tokens_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint project_export_download_tokens_ttl_check check (expires_at > created_at),
  constraint project_export_download_tokens_artifact_project_fk foreign key (artifact_id, project_id)
    references project_export_artifacts (id, project_id) on delete cascade
);
create index if not exists project_export_download_tokens_expiry_idx
  on project_export_download_tokens (expires_at, id) where revoked_at is null;

create table if not exists project_export_outbox (
  id               bigint generated always as identity primary key,
  operation_id     bigint not null unique references project_export_operations (id) on delete cascade,
  project_id       bigint not null references projects (id) on delete cascade,
  status           text not null default 'pending',
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  lease_token      varchar(128),
  lease_expires_at timestamptz,
  last_error_code  varchar(100),
  enqueued_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint project_export_outbox_status_check
    check (status in ('pending','dispatching','enqueued','retryable_failed','failed','cancelled')),
  constraint project_export_outbox_attempts_check check (attempts >= 0),
  constraint project_export_outbox_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint project_export_outbox_operation_project_fk foreign key (operation_id, project_id)
    references project_export_operations (id, project_id) on delete cascade
);
create index if not exists project_export_outbox_due_idx
  on project_export_outbox (next_attempt_at, id)
  where status in ('pending','retryable_failed');

-- Immutable editorial evidence and a project-scoped review workflow. Publication
-- delivery state continues to live in posts/publication_operations.
create table if not exists draft_revisions (
  id             bigint generated always as identity primary key,
  project_id     bigint not null references projects (id) on delete restrict,
  draft_id       bigint not null references drafts (id) on delete cascade,
  draft_version  bigint not null,
  author_user_id bigint not null references users (id) on delete restrict,
  content_hash   char(64) not null,
  snapshot       jsonb not null,
  created_at     timestamptz not null default now(),
  constraint draft_revisions_version_check check (draft_version > 0),
  constraint draft_revisions_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint draft_revisions_snapshot_check check (jsonb_typeof(snapshot) = 'object'),
  unique (draft_id, draft_version)
);
create index if not exists draft_revisions_project_draft_idx
  on draft_revisions (project_id, draft_id, draft_version desc);
create index if not exists draft_revisions_hash_idx
  on draft_revisions (project_id, draft_id, content_hash);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'draft_revisions_lineage_uniq') then
    alter table draft_revisions add constraint draft_revisions_lineage_uniq
      unique (id, project_id, draft_id, draft_version);
  end if;
end
$$;

create table if not exists draft_editorial_workflows (
  draft_id              bigint primary key references drafts (id) on delete cascade,
  project_id            bigint not null references projects (id) on delete restrict,
  state                 text not null default 'draft',
  version               bigint not null default 1,
  current_revision_id   bigint not null references draft_revisions (id) on delete restrict,
  submitted_revision_id bigint references draft_revisions (id) on delete restrict,
  submitted_by_user_id  bigint references users (id) on delete set null,
  submitted_at          timestamptz,
  approved_revision_id  bigint references draft_revisions (id) on delete restrict,
  approved_content_hash char(64),
  updated_at             timestamptz not null default now(),
  constraint draft_editorial_workflows_state_check
    check (state in ('draft','in_review','changes_requested','approved')),
  constraint draft_editorial_workflows_version_check check (version > 0),
  constraint draft_editorial_workflows_submission_check check (
    (submitted_revision_id is null and submitted_by_user_id is null and submitted_at is null)
    or (submitted_revision_id is not null and submitted_by_user_id is not null and submitted_at is not null)
  ),
  constraint draft_editorial_workflows_approval_check check (
    (state = 'approved' and approved_revision_id is not null and approved_content_hash is not null)
    or (state <> 'approved' and approved_revision_id is null and approved_content_hash is null)
  ),
  constraint draft_editorial_workflows_hash_check
    check (approved_content_hash is null or approved_content_hash ~ '^[0-9a-f]{64}$'),
  unique (project_id, draft_id)
);
create index if not exists draft_editorial_workflows_project_state_idx
  on draft_editorial_workflows (project_id, state, updated_at desc, draft_id);

create table if not exists draft_editorial_requests (
  id                    bigint generated always as identity primary key,
  project_id            bigint not null references projects (id) on delete restrict,
  draft_id              bigint not null references drafts (id) on delete cascade,
  revision_id           bigint not null references draft_revisions (id) on delete restrict,
  content_hash          char(64) not null,
  requested_by_user_id  bigint not null references users (id) on delete restrict,
  status                text not null default 'open',
  version               bigint not null default 1,
  resolved_by_user_id   bigint references users (id) on delete set null,
  requested_at          timestamptz not null default now(),
  resolved_at           timestamptz,
  constraint draft_editorial_requests_status_check
    check (status in ('open','approved','changes_requested','superseded')),
  constraint draft_editorial_requests_version_check check (version > 0),
  constraint draft_editorial_requests_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint draft_editorial_requests_resolution_check check (
    (status = 'open' and resolved_by_user_id is null and resolved_at is null)
    or (status <> 'open' and resolved_at is not null)
  )
);
create unique index if not exists draft_editorial_requests_open_uniq
  on draft_editorial_requests (draft_id) where status = 'open';
create index if not exists draft_editorial_requests_project_status_idx
  on draft_editorial_requests (project_id, status, requested_at desc, id desc);

create table if not exists draft_editorial_comments (
  id             bigint generated always as identity primary key,
  project_id     bigint not null references projects (id) on delete restrict,
  draft_id       bigint not null references drafts (id) on delete cascade,
  revision_id    bigint not null references draft_revisions (id) on delete restrict,
  content_hash   char(64) not null,
  author_user_id bigint not null references users (id) on delete restrict,
  body           text not null,
  created_at     timestamptz not null default now(),
  constraint draft_editorial_comments_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint draft_editorial_comments_body_check check (length(btrim(body)) between 1 and 4000)
);
create index if not exists draft_editorial_comments_revision_idx
  on draft_editorial_comments (project_id, draft_id, revision_id, created_at, id);

create table if not exists draft_editorial_decisions (
  id             bigint generated always as identity primary key,
  project_id     bigint not null references projects (id) on delete restrict,
  request_id     bigint not null unique references draft_editorial_requests (id) on delete cascade,
  draft_id       bigint not null references drafts (id) on delete cascade,
  revision_id    bigint not null references draft_revisions (id) on delete restrict,
  content_hash   char(64) not null,
  actor_user_id  bigint not null references users (id) on delete restrict,
  decision       text not null,
  note           text,
  created_at     timestamptz not null default now(),
  constraint draft_editorial_decisions_decision_check check (decision in ('approve','request_changes')),
  constraint draft_editorial_decisions_hash_check check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint draft_editorial_decisions_note_check check (note is null or length(note) <= 4000),
  constraint draft_editorial_decisions_changes_note_check
    check (decision = 'approve' or length(btrim(coalesce(note, ''))) > 0)
);
create index if not exists draft_editorial_decisions_project_created_idx
  on draft_editorial_decisions (project_id, created_at desc, id desc);

create table if not exists project_notifications (
  id                bigint generated always as identity primary key,
  project_id        bigint not null references projects (id) on delete cascade,
  recipient_user_id bigint not null references users (id) on delete cascade,
  actor_user_id     bigint references users (id) on delete set null,
  event_type        varchar(100) not null,
  entity_type       varchar(80) not null,
  entity_id         text not null,
  safe_data         jsonb not null default '{}'::jsonb,
  idempotency_key   varchar(180),
  read_at           timestamptz,
  created_at        timestamptz not null default now(),
  constraint project_notifications_event_check check (length(btrim(event_type)) between 1 and 100),
  constraint project_notifications_entity_check check (length(btrim(entity_type)) between 1 and 80),
  constraint project_notifications_safe_data_check check (jsonb_typeof(safe_data) = 'object')
);
create unique index if not exists project_notifications_idempotency_uniq
  on project_notifications (project_id, recipient_user_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists project_notifications_inbox_idx
  on project_notifications (project_id, recipient_user_id, read_at, created_at desc, id desc);

create or replace function aurora_reject_editorial_evidence_update()
returns trigger language plpgsql as $$
begin
  raise exception 'editorial_evidence_immutable' using errcode = '55000';
end
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'draft_revisions_immutable_update') then
    create trigger draft_revisions_immutable_update before update on draft_revisions
      for each row execute function aurora_reject_editorial_evidence_update();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'draft_editorial_decisions_immutable_update') then
    create trigger draft_editorial_decisions_immutable_update before update on draft_editorial_decisions
      for each row execute function aurora_reject_editorial_evidence_update();
  end if;
end
$$;

create or replace function aurora_assign_channel_project()
returns trigger language plpgsql as $$
begin
  if new.project_id is null then
    select channel.project_id into new.project_id from channels channel
      where channel.id = new.channel_id and channel.user_id = new.user_id;
    new.project_id := coalesce(new.project_id, aurora_selected_project_for_user(new.user_id));
  end if;
  if new.project_id is null then raise exception 'project_context_missing' using errcode = '23514'; end if;
  return new;
end
$$;

create or replace function aurora_assign_operation_project()
returns trigger language plpgsql as $$
begin
  if new.project_id is null and new.draft_id is not null then
    select draft.project_id into new.project_id from drafts draft
      where draft.id = new.draft_id and draft.user_id = new.user_id;
  end if;
  if new.project_id is null then new.project_id := aurora_selected_project_for_user(new.user_id); end if;
  if new.project_id is null then raise exception 'project_context_missing' using errcode = '23514'; end if;
  return new;
end
$$;

alter table channels add column if not exists project_id bigint references projects (id) on delete restrict;
update channels channel set project_id = project.id from projects project
 where channel.project_id is null and project.personal_owner_user_id = channel.user_id;
alter table channels alter column project_id set not null;
create index if not exists channels_project_idx on channels (project_id, id);

alter table drafts add column if not exists project_id bigint references projects (id) on delete restrict;
update drafts draft set project_id = project.id from projects project
 where draft.project_id is null and project.personal_owner_user_id = draft.user_id;
alter table drafts alter column project_id set not null;
create index if not exists drafts_project_updated_idx on drafts (project_id, updated_at desc, id desc);

alter table posts add column if not exists project_id bigint references projects (id) on delete restrict;
update posts post set project_id = coalesce(
  (select channel.project_id from channels channel where channel.id = post.channel_id),
  (select project.id from projects project where project.personal_owner_user_id = post.user_id)
) where post.project_id is null;
alter table posts alter column project_id set not null;
create index if not exists posts_project_schedule_idx on posts (project_id, scheduled_at, id);

alter table autopilot_settings add column if not exists project_id bigint references projects (id) on delete restrict;
update autopilot_settings settings set project_id = coalesce(
  (select channel.project_id from channels channel where channel.id = settings.channel_id),
  (select project.id from projects project where project.personal_owner_user_id = settings.user_id)
) where settings.project_id is null;
alter table autopilot_settings alter column project_id set not null;
create index if not exists autopilot_settings_project_idx on autopilot_settings (project_id, channel_id);

alter table content_brief add column if not exists project_id bigint references projects (id) on delete restrict;
update content_brief brief set project_id = coalesce(
  (select channel.project_id from channels channel where channel.id = brief.channel_id),
  (select project.id from projects project where project.personal_owner_user_id = brief.user_id)
) where brief.project_id is null;
alter table content_brief alter column project_id set not null;
create index if not exists content_brief_project_idx on content_brief (project_id, channel_id);

alter table publication_operations add column if not exists project_id bigint references projects (id) on delete restrict;
update publication_operations operation set project_id = coalesce(
  (select draft.project_id from drafts draft where draft.id = operation.draft_id),
  (select project.id from projects project where project.personal_owner_user_id = operation.user_id)
) where operation.project_id is null;
alter table publication_operations alter column project_id set not null;
create index if not exists publication_operations_project_created_idx
  on publication_operations (project_id, created_at desc, id desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'channels_assign_project_before_insert') then
    create trigger channels_assign_project_before_insert before insert on channels
      for each row execute function aurora_assign_user_project();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'drafts_assign_project_before_insert') then
    create trigger drafts_assign_project_before_insert before insert on drafts
      for each row execute function aurora_assign_user_project();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'posts_assign_project_before_insert') then
    create trigger posts_assign_project_before_insert before insert on posts
      for each row execute function aurora_assign_channel_project();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'autopilot_settings_assign_project_before_insert') then
    create trigger autopilot_settings_assign_project_before_insert before insert on autopilot_settings
      for each row execute function aurora_assign_channel_project();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'content_brief_assign_project_before_insert') then
    create trigger content_brief_assign_project_before_insert before insert on content_brief
      for each row execute function aurora_assign_channel_project();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'publication_operations_assign_project_before_insert') then
    create trigger publication_operations_assign_project_before_insert before insert on publication_operations
      for each row execute function aurora_assign_operation_project();
  end if;
end
$$;

-- ------------------------------------------------ Monthly content campaigns
-- Monthly campaigns are a project-scoped planning layer above the existing weekly
-- Autopilot. The existing weekly tables and workers remain the execution path.

-- A monthly item may point at one weekly Autopilot item. Give weekly plans the same
-- explicit tenant boundary as the rest of the collaboration model while preserving
-- legacy writers through the established channel-project trigger.
alter table autopilot_plan
  add column if not exists project_id bigint references projects (id) on delete restrict;
update autopilot_plan plan
   set project_id = coalesce(
     (select channel.project_id from channels channel where channel.id = plan.channel_id),
     (select project.id from projects project where project.personal_owner_user_id = plan.user_id)
   )
 where plan.project_id is null;
alter table autopilot_plan alter column project_id set not null;
create unique index if not exists autopilot_plan_id_project_uniq
  on autopilot_plan (id, project_id);
create index if not exists autopilot_plan_project_created_idx
  on autopilot_plan (project_id, created_at desc, id desc);

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'autopilot_plan_assign_project_before_insert') then
    create trigger autopilot_plan_assign_project_before_insert
      before insert on autopilot_plan for each row
      execute function aurora_assign_channel_project();
  end if;
end
$$;

-- Analytics snapshots inherit their project from the published post. The composite
-- keys below prevent a campaign item from pointing at another project's snapshot.
alter table post_stats
  add column if not exists project_id bigint references projects (id) on delete restrict;
update post_stats snapshot
   set project_id = post.project_id
  from posts post
 where snapshot.project_id is null
   and post.id = snapshot.post_id;
alter table post_stats alter column project_id set not null;
create unique index if not exists drafts_id_project_uniq on drafts (id, project_id);
create unique index if not exists post_stats_id_project_uniq on post_stats (id, project_id);
create unique index if not exists post_stats_id_post_project_uniq
  on post_stats (id, post_id, project_id);
create index if not exists post_stats_project_date_idx
  on post_stats (project_id, snapshot_date desc, id desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'post_stats_post_project_fk') then
    alter table post_stats add constraint post_stats_post_project_fk
      foreign key (post_id, project_id) references posts (id, project_id) on delete cascade;
  end if;
end
$$;

create or replace function aurora_assign_post_stats_project()
returns trigger
language plpgsql
as $$
begin
  if new.project_id is null then
    select post.project_id into new.project_id from posts post where post.id = new.post_id;
  end if;
  if new.project_id is null then
    raise exception 'project_context_missing' using errcode = '23514';
  end if;
  return new;
end
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'post_stats_assign_project_before_insert') then
    create trigger post_stats_assign_project_before_insert
      before insert on post_stats for each row
      execute function aurora_assign_post_stats_project();
  end if;
end
$$;

create table if not exists monthly_campaigns (
  id                         bigint generated always as identity primary key,
  project_id                 bigint not null references projects (id) on delete cascade,
  created_by_user_id         bigint not null references users (id) on delete restrict,
  updated_by_user_id         bigint not null references users (id) on delete restrict,
  goal                       text not null,
  starts_on                  date not null,
  ends_on                    date not null,
  timezone                   varchar(80) not null,
  rubrics                    text[] not null,
  practice_mix               jsonb not null,
  audience                   text not null,
  funnel_stages              text[] not null,
  posts_per_week             smallint not null,
  important_dates            jsonb not null default '[]'::jsonb,
  ctas                       text[] not null default '{}',
  metrics                    text[] not null default '{}',
  profile_version            bigint not null,
  content_brief_version      bigint not null,
  profile_hash               char(64) not null,
  brief_hash                 char(64) not null,
  request_key                varchar(128) not null,
  request_hash               char(64) not null,
  version                    bigint not null default 1,
  is_archived                boolean not null default false,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint monthly_campaigns_goal_check check (length(btrim(goal)) between 1 and 500),
  constraint monthly_campaigns_period_check check ((ends_on - starts_on + 1) between 28 and 31),
  constraint monthly_campaigns_timezone_check check (length(btrim(timezone)) between 1 and 80),
  constraint monthly_campaigns_rubrics_check check (cardinality(rubrics) between 3 and 6),
  constraint monthly_campaigns_practice_mix_check check (jsonb_typeof(practice_mix) = 'array'),
  constraint monthly_campaigns_audience_check check (length(btrim(audience)) between 1 and 500),
  constraint monthly_campaigns_funnel_stages_check check (
    cardinality(funnel_stages) between 1 and 3
    and funnel_stages <@ array['awareness','consideration','consultation']::text[]
  ),
  constraint monthly_campaigns_frequency_check check (posts_per_week between 1 and 14),
  constraint monthly_campaigns_important_dates_check check (jsonb_typeof(important_dates) = 'array'),
  constraint monthly_campaigns_profile_version_check check (profile_version > 0),
  constraint monthly_campaigns_content_brief_version_check check (content_brief_version > 0),
  constraint monthly_campaigns_profile_hash_check check (profile_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaigns_brief_hash_check check (brief_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaigns_request_key_check check (length(btrim(request_key)) between 8 and 128),
  constraint monthly_campaigns_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaigns_version_check check (version > 0),
  unique (project_id, request_key),
  unique (id, project_id)
);
create index if not exists monthly_campaigns_project_period_idx
  on monthly_campaigns (project_id, starts_on desc, ends_on desc, id desc)
  where is_archived = false;

-- Each plan is an immutable-numbered revision of a campaign brief. Plan.version is
-- the optimistic-concurrency counter for status, reorder and regeneration markers.
create table if not exists monthly_campaign_plans (
  id                            bigint generated always as identity primary key,
  project_id                    bigint not null references projects (id) on delete cascade,
  campaign_id                   bigint not null references monthly_campaigns (id) on delete cascade,
  revision                      bigint not null,
  status                        text not null default 'draft',
  source_campaign_version       bigint not null,
  source_brief_hash             char(64) not null,
  source_profile_hash           char(64) not null,
  source_profile_version        bigint not null,
  source_content_brief_version  bigint not null,
  request_key                   varchar(128) not null,
  request_hash                  char(64) not null,
  version                       bigint not null default 1,
  created_by_user_id            bigint not null references users (id) on delete restrict,
  submitted_by_user_id          bigint references users (id) on delete set null,
  approved_by_user_id           bigint references users (id) on delete set null,
  submitted_at                  timestamptz,
  approved_at                   timestamptz,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint monthly_campaign_plans_status_check check (status in ('draft','in_review','approved')),
  constraint monthly_campaign_plans_revision_check check (revision > 0),
  constraint monthly_campaign_plans_source_campaign_version_check check (source_campaign_version > 0),
  constraint monthly_campaign_plans_source_brief_hash_check check (source_brief_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaign_plans_source_profile_hash_check check (source_profile_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaign_plans_source_profile_version_check check (source_profile_version > 0),
  constraint monthly_campaign_plans_source_content_brief_version_check check (source_content_brief_version > 0),
  constraint monthly_campaign_plans_request_key_check check (length(btrim(request_key)) between 8 and 128),
  constraint monthly_campaign_plans_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaign_plans_version_check check (version > 0),
  constraint monthly_campaign_plans_review_check check (
    (status = 'draft' and submitted_by_user_id is null and submitted_at is null
      and approved_by_user_id is null and approved_at is null)
    or (status = 'in_review' and submitted_by_user_id is not null and submitted_at is not null
      and approved_by_user_id is null and approved_at is null)
    or (status = 'approved' and submitted_by_user_id is not null and submitted_at is not null
      and approved_by_user_id is not null and approved_at is not null)
  ),
  constraint monthly_campaign_plans_campaign_project_fk foreign key (campaign_id, project_id)
    references monthly_campaigns (id, project_id) on delete cascade,
  unique (campaign_id, revision),
  unique (campaign_id, request_key),
  unique (id, campaign_id, project_id),
  unique (id, project_id)
);
create index if not exists monthly_campaign_plans_campaign_revision_idx
  on monthly_campaign_plans (project_id, campaign_id, revision desc, id desc);
create index if not exists monthly_campaign_plans_review_idx
  on monthly_campaign_plans (project_id, status, updated_at desc, id desc);

create table if not exists monthly_campaign_items (
  id                           bigint generated always as identity primary key,
  project_id                   bigint not null references projects (id) on delete cascade,
  plan_id                      bigint not null references monthly_campaign_plans (id) on delete cascade,
  item_key                     varchar(128) not null,
  scheduled_for                date not null,
  position                     integer not null,
  title                        varchar(240) not null,
  rubric                       varchar(120) not null,
  practice                     varchar(160) not null,
  funnel_stage                 text not null,
  state                        text not null default 'topic',
  approval_status              text not null default 'draft',
  content_version              bigint not null default 1,
  approved_content_version     bigint,
  source_item_id               bigint,
  weekly_autopilot_plan_id     bigint,
  weekly_autopilot_item_index  integer,
  draft_id                     bigint,
  post_id                      bigint,
  latest_post_stats_id         bigint,
  regeneration_version         bigint not null default 0,
  regeneration_status          text not null default 'idle',
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),
  constraint monthly_campaign_items_key_check check (length(btrim(item_key)) between 1 and 128),
  constraint monthly_campaign_items_position_check check (position between 0 and 30),
  constraint monthly_campaign_items_title_check check (length(btrim(title)) between 1 and 240),
  constraint monthly_campaign_items_rubric_check check (length(btrim(rubric)) between 1 and 120),
  constraint monthly_campaign_items_practice_check check (length(btrim(practice)) between 1 and 160),
  constraint monthly_campaign_items_funnel_stage_check
    check (funnel_stage in ('awareness','consideration','consultation')),
  constraint monthly_campaign_items_state_check check (state in ('topic','detailed')),
  constraint monthly_campaign_items_approval_status_check
    check (approval_status in ('draft','in_review','approved')),
  constraint monthly_campaign_items_content_version_check check (content_version > 0),
  constraint monthly_campaign_items_approved_version_check check (
    (approval_status = 'approved' and approved_content_version = content_version)
    or (approval_status <> 'approved' and approved_content_version is null)
  ),
  constraint monthly_campaign_items_weekly_link_check check (
    (weekly_autopilot_plan_id is null and weekly_autopilot_item_index is null)
    or (weekly_autopilot_plan_id is not null and weekly_autopilot_item_index is not null
      and weekly_autopilot_item_index >= 0)
  ),
  constraint monthly_campaign_items_analytics_link_check check (
    latest_post_stats_id is null or post_id is not null
  ),
  constraint monthly_campaign_items_regeneration_version_check check (regeneration_version >= 0),
  constraint monthly_campaign_items_regeneration_status_check
    check (regeneration_status in ('idle','pending','processing','failed')),
  constraint monthly_campaign_items_plan_project_fk foreign key (plan_id, project_id)
    references monthly_campaign_plans (id, project_id) on delete cascade,
  constraint monthly_campaign_items_source_project_fk foreign key (source_item_id, project_id)
    references monthly_campaign_items (id, project_id) on delete restrict,
  constraint monthly_campaign_items_weekly_project_fk foreign key (weekly_autopilot_plan_id, project_id)
    references autopilot_plan (id, project_id) on delete restrict,
  constraint monthly_campaign_items_draft_project_fk foreign key (draft_id, project_id)
    references drafts (id, project_id) on delete restrict,
  constraint monthly_campaign_items_post_project_fk foreign key (post_id, project_id)
    references posts (id, project_id) on delete restrict,
  constraint monthly_campaign_items_stats_post_project_fk foreign key (latest_post_stats_id, post_id, project_id)
    references post_stats (id, post_id, project_id) on delete restrict,
  unique (plan_id, item_key),
  constraint monthly_campaign_items_plan_date_uniq
    unique (plan_id, scheduled_for) deferrable initially immediate,
  constraint monthly_campaign_items_plan_position_uniq
    unique (plan_id, position) deferrable initially immediate,
  unique (id, project_id)
);
create index if not exists monthly_campaign_items_plan_order_idx
  on monthly_campaign_items (project_id, plan_id, scheduled_for, position, id);
create index if not exists monthly_campaign_items_lineage_idx
  on monthly_campaign_items (project_id, weekly_autopilot_plan_id, draft_id, post_id);

-- Regeneration is an honest durable request. Until a worker consumes this outbox,
-- the existing approved text remains intact and only target markers become pending.
create table if not exists monthly_campaign_regeneration_operations (
  id                       bigint generated always as identity primary key,
  project_id               bigint not null references projects (id) on delete cascade,
  campaign_id              bigint not null references monthly_campaigns (id) on delete cascade,
  plan_id                  bigint not null references monthly_campaign_plans (id) on delete cascade,
  requested_by_user_id     bigint not null references users (id) on delete restrict,
  scope                    text not null,
  week_starts_on           date,
  request_key              varchar(128) not null,
  request_hash             char(64) not null,
  base_plan_version        bigint not null,
  base_brief_hash          char(64) not null,
  base_profile_hash        char(64) not null,
  status                   text not null default 'pending',
  result_plan_id           bigint,
  error_code               varchar(100),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  completed_at             timestamptz,
  constraint monthly_campaign_regeneration_scope_check check (scope in ('item','week')),
  constraint monthly_campaign_regeneration_week_check check (
    (scope = 'item' and week_starts_on is null)
    or (scope = 'week' and week_starts_on is not null)
  ),
  constraint monthly_campaign_regeneration_request_key_check
    check (length(btrim(request_key)) between 8 and 128),
  constraint monthly_campaign_regeneration_request_hash_check check (request_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaign_regeneration_plan_version_check check (base_plan_version > 0),
  constraint monthly_campaign_regeneration_brief_hash_check check (base_brief_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaign_regeneration_profile_hash_check check (base_profile_hash ~ '^[0-9a-f]{64}$'),
  constraint monthly_campaign_regeneration_status_check
    check (status in ('pending','processing','completed','stale','retryable_failed','failed','cancelled')),
  constraint monthly_campaign_regeneration_result_check check (
    (status = 'completed' and result_plan_id is not null and completed_at is not null)
    or (status <> 'completed' and result_plan_id is null)
  ),
  constraint monthly_campaign_regeneration_campaign_project_fk foreign key (campaign_id, project_id)
    references monthly_campaigns (id, project_id) on delete cascade,
  constraint monthly_campaign_regeneration_plan_project_fk foreign key (plan_id, campaign_id, project_id)
    references monthly_campaign_plans (id, campaign_id, project_id) on delete cascade,
  constraint monthly_campaign_regeneration_result_project_fk foreign key (result_plan_id, campaign_id, project_id)
    references monthly_campaign_plans (id, campaign_id, project_id) on delete restrict,
  unique (project_id, request_key),
  unique (id, project_id)
);
create index if not exists monthly_campaign_regeneration_plan_idx
  on monthly_campaign_regeneration_operations (project_id, plan_id, created_at desc, id desc);
create index if not exists monthly_campaign_regeneration_pending_idx
  on monthly_campaign_regeneration_operations (status, updated_at, id)
  where status in ('pending','retryable_failed');

create table if not exists monthly_campaign_regeneration_targets (
  operation_id        bigint not null references monthly_campaign_regeneration_operations (id) on delete cascade,
  project_id          bigint not null references projects (id) on delete cascade,
  item_id             bigint not null references monthly_campaign_items (id) on delete cascade,
  item_content_version bigint not null,
  created_at          timestamptz not null default now(),
  constraint monthly_campaign_regeneration_targets_version_check check (item_content_version > 0),
  constraint monthly_campaign_regeneration_targets_operation_project_fk foreign key (operation_id, project_id)
    references monthly_campaign_regeneration_operations (id, project_id) on delete cascade,
  constraint monthly_campaign_regeneration_targets_item_project_fk foreign key (item_id, project_id)
    references monthly_campaign_items (id, project_id) on delete cascade,
  primary key (operation_id, item_id)
);

create table if not exists monthly_campaign_regeneration_outbox (
  id               bigint generated always as identity primary key,
  operation_id     bigint not null unique references monthly_campaign_regeneration_operations (id) on delete cascade,
  project_id       bigint not null references projects (id) on delete cascade,
  status           text not null default 'pending',
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  lease_token      varchar(128),
  lease_expires_at timestamptz,
  last_error_code  varchar(100),
  enqueued_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint monthly_campaign_regeneration_outbox_status_check
    check (status in ('pending','dispatching','enqueued','retryable_failed','failed','cancelled')),
  constraint monthly_campaign_regeneration_outbox_attempts_check check (attempts >= 0),
  constraint monthly_campaign_regeneration_outbox_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  constraint monthly_campaign_regeneration_outbox_operation_project_fk foreign key (operation_id, project_id)
    references monthly_campaign_regeneration_operations (id, project_id) on delete cascade
);
create index if not exists monthly_campaign_regeneration_outbox_due_idx
  on monthly_campaign_regeneration_outbox (next_attempt_at, id)
  where status in ('pending','retryable_failed');
-- ------------------------------------------------ Autopilot project boundary

-- Autopilot is shared project state. `user_id` records the actor/creator, but it is
-- never the tenant boundary. These composite keys make a cross-project relation
-- impossible even if a future application query forgets one predicate.
create unique index if not exists channels_id_project_uniq
  on channels (id, project_id);
create unique index if not exists autopilot_settings_project_channel_uniq
  on autopilot_settings (project_id, channel_id);
create unique index if not exists content_brief_project_channel_uniq
  on content_brief (project_id, channel_id);

alter table monthly_campaign_regeneration_targets
  add column if not exists item_regeneration_version bigint;
update monthly_campaign_regeneration_targets target
   set item_regeneration_version = item.regeneration_version
  from monthly_campaign_items item
 where item.id = target.item_id and item.project_id = target.project_id
   and target.item_regeneration_version is null;
alter table monthly_campaign_regeneration_targets
  alter column item_regeneration_version set not null;

alter table autopilot_approval_operations
  add column if not exists project_id bigint references projects (id) on delete restrict;
update autopilot_approval_operations operation
   set project_id = coalesce(
     (select plan.project_id from autopilot_plan plan where plan.id = operation.plan_id),
     (select channel.project_id from channels channel where channel.id = operation.channel_id)
   )
 where operation.project_id is null;
alter table autopilot_approval_operations alter column project_id set not null;
create unique index if not exists autopilot_approval_operations_id_project_uniq
  on autopilot_approval_operations (id, project_id);
create unique index if not exists autopilot_approval_operations_project_actor_key_uniq
  on autopilot_approval_operations (project_id, user_id, idempotency_key);
create index if not exists autopilot_approval_operations_project_plan_idx
  on autopilot_approval_operations (project_id, plan_id, created_at desc, id desc);

alter table autopilot_approval_previews
  add column if not exists project_id bigint references projects (id) on delete restrict;
update autopilot_approval_previews preview
   set project_id = coalesce(
     (select plan.project_id from autopilot_plan plan where plan.id = preview.plan_id),
     (select operation.project_id
        from autopilot_approval_operations operation
       where operation.id = preview.operation_id),
     (select channel.project_id from channels channel where channel.id = preview.channel_id)
   )
 where preview.project_id is null;
alter table autopilot_approval_previews alter column project_id set not null;

alter table autopilot_schedule_outbox
  add column if not exists project_id bigint references projects (id) on delete restrict;
update autopilot_schedule_outbox outbox
   set project_id = coalesce(
     (select plan.project_id from autopilot_plan plan where plan.id = outbox.plan_id),
     (select post.project_id from posts post where post.id = outbox.post_id),
     (select channel.project_id from channels channel where channel.id = outbox.channel_id)
   )
 where outbox.project_id is null;
alter table autopilot_schedule_outbox alter column project_id set not null;
create index if not exists autopilot_schedule_outbox_project_pending_idx
  on autopilot_schedule_outbox (project_id, updated_at, id)
  where status = 'pending';
create index if not exists monthly_campaign_regeneration_outbox_redelivery_idx
  on monthly_campaign_regeneration_outbox (updated_at, id)
  where status = 'enqueued';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'autopilot_settings_channel_project_fk') then
    alter table autopilot_settings add constraint autopilot_settings_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'content_brief_channel_project_fk') then
    alter table content_brief add constraint content_brief_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_plan_channel_project_fk') then
    alter table autopilot_plan add constraint autopilot_plan_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_plan_approval_operation_project_fk') then
    alter table autopilot_plan add constraint autopilot_plan_approval_operation_project_fk
      foreign key (approval_operation_id, project_id)
      references autopilot_approval_operations (id, project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'posts_channel_project_fk') then
    alter table posts add constraint posts_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_approval_operations_channel_project_fk') then
    alter table autopilot_approval_operations add constraint autopilot_approval_operations_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_approval_operations_plan_project_fk') then
    alter table autopilot_approval_operations add constraint autopilot_approval_operations_plan_project_fk
      foreign key (plan_id, project_id) references autopilot_plan (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_approval_previews_channel_project_fk') then
    alter table autopilot_approval_previews add constraint autopilot_approval_previews_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_approval_previews_plan_project_fk') then
    alter table autopilot_approval_previews add constraint autopilot_approval_previews_plan_project_fk
      foreign key (plan_id, project_id) references autopilot_plan (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_approval_previews_operation_project_fk') then
    alter table autopilot_approval_previews add constraint autopilot_approval_previews_operation_project_fk
      foreign key (operation_id, project_id)
      references autopilot_approval_operations (id, project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_schedule_outbox_plan_project_fk') then
    alter table autopilot_schedule_outbox add constraint autopilot_schedule_outbox_plan_project_fk
      foreign key (plan_id, project_id) references autopilot_plan (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_schedule_outbox_channel_project_fk') then
    alter table autopilot_schedule_outbox add constraint autopilot_schedule_outbox_channel_project_fk
      foreign key (channel_id, project_id) references channels (id, project_id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_schedule_outbox_operation_project_fk') then
    alter table autopilot_schedule_outbox add constraint autopilot_schedule_outbox_operation_project_fk
      foreign key (operation_id, project_id)
      references autopilot_approval_operations (id, project_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'autopilot_schedule_outbox_post_project_fk') then
    alter table autopilot_schedule_outbox add constraint autopilot_schedule_outbox_post_project_fk
      foreign key (post_id, project_id) references posts (id, project_id) on delete cascade;
  end if;
end
$$;

-- Media belongs to the selected project. user_id remains creator/actor metadata only.
alter table media_assets add column if not exists project_id bigint references projects (id) on delete restrict;
alter table media_assets add column if not exists origin text not null default 'legacy';
alter table media_assets add column if not exists width_px integer;
alter table media_assets add column if not exists height_px integer;
alter table media_assets add column if not exists metadata jsonb not null default '{}'::jsonb;
update media_assets asset
   set project_id = coalesce(
     (select project.id from projects project where project.personal_owner_user_id = asset.user_id),
     aurora_selected_project_for_user(asset.user_id)
   )
 where asset.project_id is null;
alter table media_assets alter column project_id set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'media_assets_origin_check') then
    alter table media_assets add constraint media_assets_origin_check
      check (origin in ('legacy','upload','media_generation','legal_visual_render'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'media_assets_dimensions_check') then
    alter table media_assets add constraint media_assets_dimensions_check check (
      (width_px is null and height_px is null)
      or (width_px > 0 and height_px > 0)
    );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'media_assets_metadata_check') then
    alter table media_assets add constraint media_assets_metadata_check
      check (jsonb_typeof(metadata) = 'object');
  end if;
end
$$;
create unique index if not exists media_assets_id_project_uniq on media_assets (id, project_id);
create index if not exists media_assets_project_created_idx
  on media_assets (project_id, created_at desc, id desc);
create index if not exists media_assets_project_origin_created_idx
  on media_assets (project_id, origin, created_at desc, id desc);

alter table media_generations add column if not exists project_id bigint references projects (id) on delete restrict;
alter table media_generations add column if not exists created_at timestamptz not null default now();
update media_generations generation
   set project_id = coalesce(
     (select project.id from projects project where project.personal_owner_user_id = generation.user_id),
     aurora_selected_project_for_user(generation.user_id)
   )
 where generation.project_id is null;
alter table media_generations alter column project_id set not null;
create unique index if not exists media_generations_id_project_uniq
  on media_generations (id, project_id);
create index if not exists media_generations_project_created_idx
  on media_generations (project_id, created_at desc, id desc);
drop index if exists media_generations_user_request_key_uniq;
create unique index if not exists media_generations_project_request_key_uniq
  on media_generations (project_id, request_key) where request_key is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'media_generations'::regclass
       and conname = 'media_generations_output_asset_project_fk'
  ) then
    alter table media_generations
      add constraint media_generations_output_asset_project_fk
      foreign key (output_asset_id, project_id)
      references media_assets (id, project_id) on delete no action;
  end if;
end
$$;

-- Account avatars are not project media. Keeping them in a separate table prevents a
-- project switch from breaking the image and prevents project members from reusing it
-- as a post asset.
create table if not exists user_avatar_assets (
  id         bigint generated always as identity primary key,
  user_id    bigint not null references users (id) on delete cascade,
  file_name  text not null,
  mime_type  text not null check (mime_type in ('image/webp','image/png','image/jpeg')),
  bytes      integer not null check (bytes > 0 and bytes <= 5242880),
  data       bytea not null,
  sha256     char(64) not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (user_id, sha256, mime_type)
);
create index if not exists user_avatar_assets_user_created_idx
  on user_avatar_assets (user_id, created_at desc, id desc);

with copied as (
  insert into user_avatar_assets (user_id, file_name, mime_type, bytes, data, sha256, created_at)
  select asset.user_id, asset.file_name, asset.mime_type, asset.bytes, asset.data, asset.sha256, asset.created_at
    from media_assets asset
    join users user_row on user_row.id = asset.user_id
   where user_row.avatar = '/api/media/assets/' || asset.id::text
     and asset.kind = 'image'
     and asset.storage_backend = 'postgres'
     and asset.data is not null
  on conflict (user_id, sha256, mime_type) do update set file_name = excluded.file_name
  returning id, user_id
)
update users user_row
   set avatar = '/api/settings/profile/avatar-assets/' || copied.id::text
  from copied
 where user_row.id = copied.user_id
   and user_row.avatar like '/api/media/assets/%';

-- Draft revisions already have a globally unique id. The wider key lets every
-- downstream artefact prove that revision, draft and project belong together.
-- The immutable 20260817_legal_visuals migration installs the composite revision
-- lineage constraint after this bootstrap snapshot is loaded. This differently
-- named bootstrap index is required while the remainder of this monolithic schema
-- creates composite foreign keys; the migration then records the canonical named
-- constraint without mutating its already-applied historical SQL.
create unique index if not exists draft_revisions_lineage_bootstrap_uniq
  on draft_revisions (id, project_id, draft_id, draft_version);

create table if not exists project_brand_kits (
  project_id       bigint primary key references projects (id) on delete cascade,
  name             varchar(100) not null,
  logo_asset_id    bigint,
  colors           jsonb not null,
  allowed_fonts    text[] not null,
  active_font      text not null,
  signature        varchar(160) not null default '',
  version          bigint not null default 1,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint project_brand_kits_name_check check (length(btrim(name)) between 1 and 100),
  constraint project_brand_kits_colors_check check (
    jsonb_typeof(colors) = 'object'
    and colors ?& array['background','surface','text','mutedText','accent','critical']
    and (colors->>'background') ~ '^#[0-9a-f]{6}$'
    and (colors->>'surface') ~ '^#[0-9a-f]{6}$'
    and (colors->>'text') ~ '^#[0-9a-f]{6}$'
    and (colors->>'mutedText') ~ '^#[0-9a-f]{6}$'
    and (colors->>'accent') ~ '^#[0-9a-f]{6}$'
    and (colors->>'critical') ~ '^#[0-9a-f]{6}$'
  ),
  constraint project_brand_kits_fonts_check check (
    cardinality(allowed_fonts) between 1 and 3
    and allowed_fonts <@ array['aurora-sans','legal-serif','technical-mono']::text[]
    and active_font = any(allowed_fonts)
  ),
  constraint project_brand_kits_signature_check check (length(signature) <= 160),
  constraint project_brand_kits_version_check check (version > 0),
  constraint project_brand_kits_logo_project_fk
    foreign key (logo_asset_id, project_id)
    references media_assets (id, project_id) on delete restrict
);

create table if not exists legal_visual_designs (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  source_draft_id    bigint,
  source_draft_revision_id bigint,
  source_draft_version bigint,
  source_content_hash char(64),
  name               varchar(160) not null,
  format             text not null,
  status             text not null default 'draft',
  revision           bigint not null default 1,
  config             jsonb not null,
  config_hash        char(64) not null,
  rendered_revision  bigint,
  request_key        varchar(96) not null,
  error_code         varchar(100),
  error_message      varchar(500),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint legal_visual_designs_name_check check (length(btrim(name)) between 1 and 160),
  constraint legal_visual_designs_format_check check (format in ('1:1','4:5','9:16')),
  constraint legal_visual_designs_status_check
    check (status in ('draft','render_queued','rendering','ready','render_failed')),
  constraint legal_visual_designs_revision_check
    check (revision > 0 and (rendered_revision is null or rendered_revision > 0)),
  constraint legal_visual_designs_config_check check (jsonb_typeof(config) = 'object'),
  constraint legal_visual_designs_hash_check check (config_hash ~ '^[0-9a-f]{64}$'),
  constraint legal_visual_designs_source_hash_check check (
    source_content_hash is null or source_content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint legal_visual_designs_source_revision_check check (
    (source_draft_id is null and source_draft_revision_id is null
      and source_draft_version is null and source_content_hash is null)
    or (source_draft_id is not null and source_draft_revision_id is not null
      and source_draft_version > 0 and source_content_hash is not null)
  ),
  constraint legal_visual_designs_request_key_check
    check (request_key ~ '^[A-Za-z0-9:_-]{8,96}$'),
  constraint legal_visual_designs_source_draft_project_fk
    foreign key (source_draft_id, project_id)
    references drafts (id, project_id) on delete restrict,
  constraint legal_visual_designs_source_revision_project_fk
    foreign key (source_draft_revision_id, project_id, source_draft_id, source_draft_version)
    references draft_revisions (id, project_id, draft_id, draft_version) on delete restrict,
  unique (project_id, request_key),
  unique (id, project_id)
);
create index if not exists legal_visual_designs_project_updated_idx
  on legal_visual_designs (project_id, updated_at desc, id desc);
create index if not exists legal_visual_designs_source_draft_idx
  on legal_visual_designs (project_id, source_draft_id, updated_at desc)
  where source_draft_id is not null;

create table if not exists legal_visual_source_assets (
  design_id       bigint not null,
  project_id      bigint not null,
  card_id         varchar(128) not null,
  media_asset_id  bigint not null,
  role            text not null default 'illustration',
  created_at      timestamptz not null default now(),
  primary key (design_id, card_id, media_asset_id),
  constraint legal_visual_source_assets_design_project_fk
    foreign key (design_id, project_id)
    references legal_visual_designs (id, project_id) on delete cascade,
  constraint legal_visual_source_assets_asset_project_fk
    foreign key (media_asset_id, project_id)
    references media_assets (id, project_id) on delete restrict,
  constraint legal_visual_source_assets_card_check
    check (length(btrim(card_id)) between 1 and 128),
  constraint legal_visual_source_assets_role_check
    check (role in ('illustration','background')),
  unique (project_id, design_id, card_id)
);
create index if not exists legal_visual_source_assets_asset_idx
  on legal_visual_source_assets (project_id, media_asset_id, design_id);

create table if not exists legal_visual_render_operations (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  design_id          bigint not null,
  requested_by_user_id bigint not null references users (id) on delete restrict,
  design_revision    bigint not null,
  config_snapshot    jsonb not null,
  config_hash        char(64) not null,
  status             text not null default 'pending',
  attempts           integer not null default 0,
  idempotency_key    varchar(128) not null,
  error_code         varchar(100),
  error_message      varchar(500),
  started_at         timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint legal_visual_render_operations_design_project_fk
    foreign key (design_id, project_id)
    references legal_visual_designs (id, project_id) on delete cascade,
  constraint legal_visual_render_operations_revision_check check (design_revision > 0),
  constraint legal_visual_render_operations_snapshot_check check (jsonb_typeof(config_snapshot) = 'object'),
  constraint legal_visual_render_operations_hash_check check (config_hash ~ '^[0-9a-f]{64}$'),
  constraint legal_visual_render_operations_status_check check (
    status in ('pending','queued','rendering','ready','retryable_failed','failed')
  ),
  constraint legal_visual_render_operations_attempts_check check (attempts >= 0),
  constraint legal_visual_render_operations_completion_check check (
    (status in ('ready','failed') and completed_at is not null)
    or (status not in ('ready','failed') and completed_at is null)
  ),
  unique (project_id, idempotency_key),
  unique (design_id, design_revision, config_hash),
  unique (id, project_id),
  unique (id, project_id, design_id)
);
create index if not exists legal_visual_render_operations_project_status_idx
  on legal_visual_render_operations (project_id, status, updated_at desc, id desc);

create table if not exists legal_visual_render_cards (
  operation_id   bigint not null,
  project_id     bigint not null,
  design_id      bigint not null,
  card_id        varchar(128) not null,
  card_order     integer not null,
  media_asset_id bigint not null,
  sha256         char(64) not null,
  width          integer not null,
  height         integer not null,
  created_at     timestamptz not null default now(),
  primary key (operation_id, card_order),
  constraint legal_visual_render_cards_operation_project_fk
    foreign key (operation_id, project_id, design_id)
    references legal_visual_render_operations (id, project_id, design_id) on delete cascade,
  constraint legal_visual_render_cards_asset_project_fk
    foreign key (media_asset_id, project_id)
    references media_assets (id, project_id) on delete restrict,
  constraint legal_visual_render_cards_order_check check (card_order between 1 and 7),
  constraint legal_visual_render_cards_id_check check (length(btrim(card_id)) between 1 and 128),
  constraint legal_visual_render_cards_hash_check check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint legal_visual_render_cards_dimensions_check check (width > 0 and height > 0),
  unique (project_id, operation_id, card_id),
  unique (media_asset_id)
);
create index if not exists legal_visual_render_cards_design_idx
  on legal_visual_render_cards (project_id, design_id, operation_id, card_order);

create table if not exists legal_visual_render_outbox (
  id               bigint generated always as identity primary key,
  operation_id     bigint not null,
  project_id       bigint not null,
  status           text not null default 'pending',
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  lease_token      uuid,
  lease_expires_at timestamptz,
  enqueued_at      timestamptz,
  last_error_code  varchar(100),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint legal_visual_render_outbox_operation_project_fk
    foreign key (operation_id, project_id)
    references legal_visual_render_operations (id, project_id) on delete cascade,
  constraint legal_visual_render_outbox_status_check check (
    status in ('pending','dispatching','enqueued','retryable_failed','failed','completed','cancelled')
  ),
  constraint legal_visual_render_outbox_attempts_check check (attempts >= 0),
  constraint legal_visual_render_outbox_lease_check check (
    (status = 'dispatching' and lease_token is not null and lease_expires_at is not null)
    or (status <> 'dispatching' and lease_token is null and lease_expires_at is null)
  ),
  unique (operation_id),
  unique (project_id, operation_id)
);
create index if not exists legal_visual_render_outbox_due_idx
  on legal_visual_render_outbox (next_attempt_at, id)
  where status in ('pending','retryable_failed','enqueued');

create table if not exists legal_video_scripts (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  source_draft_id    bigint not null,
  source_draft_revision_id bigint not null,
  source_draft_version bigint not null,
  source_content_hash char(64) not null,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  title              varchar(180) not null,
  duration_seconds   integer not null,
  revision           bigint not null default 1,
  revision_hash      char(64) not null,
  snapshot           jsonb not null,
  request_key        varchar(96) not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint legal_video_scripts_source_draft_project_fk
    foreign key (source_draft_id, project_id)
    references drafts (id, project_id) on delete restrict,
  constraint legal_video_scripts_source_revision_project_fk
    foreign key (source_draft_revision_id, project_id, source_draft_id, source_draft_version)
    references draft_revisions (id, project_id, draft_id, draft_version) on delete restrict,
  constraint legal_video_scripts_title_check check (length(btrim(title)) between 1 and 180),
  constraint legal_video_scripts_duration_check check (duration_seconds in (30,45,60)),
  constraint legal_video_scripts_revision_check check (revision > 0 and source_draft_version > 0),
  constraint legal_video_scripts_hash_check check (
    revision_hash ~ '^[0-9a-f]{64}$' and source_content_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint legal_video_scripts_snapshot_check check (jsonb_typeof(snapshot) = 'object'),
  constraint legal_video_scripts_request_key_check check (request_key ~ '^[A-Za-z0-9:_-]{8,96}$'),
  unique (project_id, request_key),
  unique (id, project_id)
);
create index if not exists legal_video_scripts_project_updated_idx
  on legal_video_scripts (project_id, updated_at desc, id desc);
create index if not exists legal_video_scripts_source_draft_idx
  on legal_video_scripts (project_id, source_draft_id, updated_at desc, id desc);

create table if not exists legal_video_script_revisions (
  id             bigint generated always as identity primary key,
  script_id      bigint not null,
  project_id     bigint not null,
  revision       bigint not null,
  revision_hash  char(64) not null,
  snapshot       jsonb not null,
  actor_user_id  bigint not null references users (id) on delete restrict,
  created_at     timestamptz not null default now(),
  constraint legal_video_script_revisions_script_project_fk
    foreign key (script_id, project_id)
    references legal_video_scripts (id, project_id) on delete cascade,
  constraint legal_video_script_revisions_revision_check check (revision > 0),
  constraint legal_video_script_revisions_hash_check check (revision_hash ~ '^[0-9a-f]{64}$'),
  constraint legal_video_script_revisions_snapshot_check check (jsonb_typeof(snapshot) = 'object'),
  unique (script_id, revision),
  unique (project_id, script_id, revision_hash)
);
create index if not exists legal_video_script_revisions_project_idx
  on legal_video_script_revisions (project_id, script_id, revision desc);

create or replace function aurora_reject_legal_video_revision_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'legal_video_revision_immutable' using errcode = '55000';
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger where tgname = 'legal_video_script_revisions_immutable_update'
  ) then
    create trigger legal_video_script_revisions_immutable_update
      before update on legal_video_script_revisions for each row
      execute function aurora_reject_legal_video_revision_update();
  end if;
end
$$;

create table if not exists legal_visual_render_attempts (
  id              bigint generated always as identity primary key,
  project_id      bigint not null references projects (id) on delete cascade,
  operation_id    bigint not null,
  attempt_number  integer not null,
  status          text not null,
  safe_error_code varchar(100),
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  constraint legal_visual_render_attempts_operation_project_fk
    foreign key (operation_id, project_id)
    references legal_visual_render_operations (id, project_id) on delete cascade,
  constraint legal_visual_render_attempts_number_check check (attempt_number > 0),
  constraint legal_visual_render_attempts_status_check
    check (status in ('running','succeeded','failed_retry','failed')),
  constraint legal_visual_render_attempts_error_check
    check (safe_error_code is null or safe_error_code ~ '^[a-z0-9_]{1,100}$'),
  constraint legal_visual_render_attempts_completion_check check (
    (status = 'running' and completed_at is null)
    or (status <> 'running' and completed_at is not null)
  ),
  unique (operation_id, attempt_number)
);
create index if not exists legal_visual_render_attempts_project_operation_idx
  on legal_visual_render_attempts (project_id, operation_id, attempt_number);

-- One monotonic dictionary version per project. Publication snapshots persist this
-- version together with the deterministic rules version used for the final recheck.
create table if not exists project_brand_dictionaries (
  project_id         bigint primary key references projects (id) on delete cascade,
  version            bigint not null default 1,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint project_brand_dictionaries_version_check check (version > 0)
);
insert into project_brand_dictionaries (
  project_id, version, created_by_user_id, updated_by_user_id, created_at, updated_at
)
select project.id, 1, project.created_by_user_id, project.created_by_user_id,
       project.created_at, project.updated_at
  from projects project
on conflict (project_id) do nothing;

-- Entries are soft-deleted so an audit event and an old publication snapshot can
-- still identify the exact rule that existed at an earlier dictionary version.
create table if not exists project_brand_dictionary_entries (
  id                 bigint generated always as identity primary key,
  project_id         bigint not null references projects (id) on delete cascade,
  kind               text not null,
  term               varchar(240) not null,
  replacement        varchar(240),
  expansion          varchar(500),
  case_sensitive     boolean not null default false,
  is_active          boolean not null default true,
  version            bigint not null default 1,
  created_by_user_id bigint not null references users (id) on delete restrict,
  updated_by_user_id bigint not null references users (id) on delete restrict,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint project_brand_dictionary_entries_kind_check check (
    kind in ('canonical','allowed','prohibited','exception','abbreviation')
  ),
  constraint project_brand_dictionary_entries_term_check check (
    length(btrim(term)) between 1 and 240 and term = btrim(term)
  ),
  constraint project_brand_dictionary_entries_replacement_check check (
    (
      kind in ('canonical','prohibited','abbreviation')
      and replacement is not null
      and length(btrim(replacement)) between 1 and 240
      and replacement = btrim(replacement)
    )
    or (kind in ('allowed','exception') and replacement is null)
  ),
  constraint project_brand_dictionary_entries_expansion_check check (
    expansion is null or (length(btrim(expansion)) between 1 and 500 and expansion = btrim(expansion))
  ),
  constraint project_brand_dictionary_entries_version_check check (version > 0),
  unique (id, project_id)
);
create unique index if not exists project_brand_dictionary_entries_active_term_uniq
  on project_brand_dictionary_entries (project_id, kind, lower(term))
  where is_active;
create index if not exists project_brand_dictionary_entries_project_idx
  on project_brand_dictionary_entries (project_id, is_active desc, kind, lower(term), id);

-- Every explicit apply/reject is server-rechecked and durable. Source/result text is
-- bounded to the Composer limit so an accepted run can be undone after a save, while
-- hashes make publication comparison cheap and deterministic.
create table if not exists project_typography_runs (
  id                    bigint generated always as identity primary key,
  project_id            bigint not null references projects (id) on delete cascade,
  actor_user_id         bigint not null references users (id) on delete restrict,
  draft_id              bigint,
  request_key           varchar(96) not null,
  rules_version         varchar(80) not null,
  dictionary_version    bigint not null,
  source_text           text not null,
  result_text           text not null,
  source_text_hash      char(64) not null,
  result_text_hash      char(64) not null,
  suggestions           jsonb not null,
  accepted_suggestion_ids jsonb not null default '[]'::jsonb,
  rejected_suggestion_ids jsonb not null default '[]'::jsonb,
  review_complete       boolean not null default false,
  undone_at             timestamptz,
  undone_by_user_id     bigint references users (id) on delete restrict,
  created_at            timestamptz not null default now(),
  constraint project_typography_runs_draft_project_fk foreign key (draft_id, project_id)
    references drafts (id, project_id) on delete cascade,
  constraint project_typography_runs_request_key_check check (length(btrim(request_key)) between 16 and 96),
  constraint project_typography_runs_rules_version_check check (length(btrim(rules_version)) between 1 and 80),
  constraint project_typography_runs_dictionary_version_check check (dictionary_version > 0),
  constraint project_typography_runs_source_length_check check (length(source_text) between 1 and 50000),
  constraint project_typography_runs_result_length_check check (length(result_text) between 1 and 50000),
  constraint project_typography_runs_source_hash_check check (source_text_hash ~ '^[0-9a-f]{64}$'),
  constraint project_typography_runs_result_hash_check check (result_text_hash ~ '^[0-9a-f]{64}$'),
  constraint project_typography_runs_suggestions_check check (jsonb_typeof(suggestions) = 'array'),
  constraint project_typography_runs_accepted_check check (jsonb_typeof(accepted_suggestion_ids) = 'array'),
  constraint project_typography_runs_rejected_check check (jsonb_typeof(rejected_suggestion_ids) = 'array'),
  constraint project_typography_runs_undo_check check (
    (undone_at is null and undone_by_user_id is null)
    or (undone_at is not null and undone_by_user_id is not null)
  ),
  unique (project_id, request_key),
  unique (id, project_id)
);
create index if not exists project_typography_runs_draft_created_idx
  on project_typography_runs (project_id, draft_id, created_at desc, id desc)
  where draft_id is not null;
create index if not exists project_typography_runs_review_hash_idx
  on project_typography_runs
    (project_id, dictionary_version, rules_version, result_text_hash, created_at desc, id desc)
  where review_complete and undone_at is null;

-- An Autopilot week may be materialized from one approved monthly plan. The selected
-- project is part of the FK, so a queued job cannot attach another tenant's campaign.
alter table autopilot_plan
  add column if not exists monthly_campaign_plan_id bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'autopilot_plan_monthly_campaign_project_fk'
  ) then
    alter table autopilot_plan
      add constraint autopilot_plan_monthly_campaign_project_fk
      foreign key (monthly_campaign_plan_id, project_id)
      references monthly_campaign_plans (id, project_id)
      on delete restrict;
  end if;
end
$$;

create index if not exists autopilot_plan_monthly_campaign_idx
  on autopilot_plan (project_id, monthly_campaign_plan_id, created_at desc, id desc)
  where monthly_campaign_plan_id is not null;

-- A reusable short link is a campaign asset, while every published destination needs
-- its own opaque redirect identity. This placement makes post-level attribution exact
-- without exposing a post, channel or project identifier in the public URL.
create table if not exists short_link_placements (
  id                       bigint generated always as identity primary key,
  project_id               bigint not null references projects (id) on delete cascade,
  short_link_id            bigint not null references short_links (id) on delete cascade,
  publication_operation_id bigint,
  post_id                  bigint,
  slug                     varchar(64) not null unique,
  created_at               timestamptz not null default now(),
  constraint short_link_placements_slug_check check (slug ~ '^[A-Za-z0-9_-]{20,64}$'),
  constraint short_link_placements_link_project_fk
    foreign key (short_link_id, project_id)
    references short_links (id, project_id) on delete cascade,
  constraint short_link_placements_operation_project_fk
    foreign key (publication_operation_id, project_id)
    references publication_operations (id, project_id)
    on delete set null (publication_operation_id),
  constraint short_link_placements_post_project_fk
    foreign key (post_id, project_id)
    references posts (id, project_id)
    on delete set null (post_id),
  unique (post_id),
  unique (publication_operation_id, post_id),
  unique (id, short_link_id, project_id)
);
create index if not exists short_link_placements_link_idx
  on short_link_placements (short_link_id, created_at desc, id desc);
create index if not exists short_link_placements_project_idx
  on short_link_placements (project_id, created_at desc, id desc);

alter table short_link_clicks
  add column if not exists placement_id bigint;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'short_link_clicks_placement_link_project_fk'
  ) then
    alter table short_link_clicks
      add constraint short_link_clicks_placement_link_project_fk
      foreign key (placement_id, short_link_id, project_id)
      references short_link_placements (id, short_link_id, project_id)
      on delete set null (placement_id);
  end if;
end
$$;
create index if not exists short_link_clicks_placement_time_idx
  on short_link_clicks (placement_id, occurred_at desc, id)
  where placement_id is not null;

alter table publication_tracking_snapshots
  add column if not exists short_link_placement_id bigint;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'publication_tracking_placement_link_project_fk'
  ) then
    alter table publication_tracking_snapshots
      add constraint publication_tracking_placement_link_project_fk
      foreign key (short_link_placement_id, short_link_id, project_id)
      references short_link_placements (id, short_link_id, project_id)
      on delete set null (short_link_placement_id);
  end if;
end
$$;
create unique index if not exists publication_tracking_short_placement_uniq
  on publication_tracking_snapshots (short_link_placement_id)
  where short_link_placement_id is not null;

-- Legacy publication operations cannot be tied to an immutable editorial approval
-- reliably. Keep the new lineage nullable for those rows, while requiring every new
-- approved publication to carry one complete, project-scoped revision identity.
alter table publication_operations
  add column if not exists approved_revision_id bigint;
alter table publication_operations
  add column if not exists approved_draft_version bigint;
alter table publication_operations
  add column if not exists approved_content_hash char(64);

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'publication_operations'::regclass
       and conname = 'publication_operations_approved_lineage_check'
  ) then
    alter table publication_operations
      add constraint publication_operations_approved_lineage_check
      check (
        (
          approved_revision_id is null
          and approved_draft_version is null
          and approved_content_hash is null
        )
        or (
          approved_revision_id is not null
          and draft_id is not null
          and approved_draft_version is not null
          and approved_draft_version = draft_version
          and approved_content_hash is not null
        )
      );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'publication_operations'::regclass
       and conname = 'publication_operations_approved_content_hash_check'
  ) then
    alter table publication_operations
      add constraint publication_operations_approved_content_hash_check
      check (
        approved_content_hash is null
        or approved_content_hash ~ '^[0-9a-f]{64}$'
      );
  end if;
end
$$;

-- PostgreSQL requires an exact unique key for the wider approval foreign key.
-- Including the globally unique revision id makes this additive and duplicate-safe.
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'draft_revisions'::regclass
       and conname = 'draft_revisions_approval_lineage_uniq'
  ) then
    alter table draft_revisions
      add constraint draft_revisions_approval_lineage_uniq
      unique (id, project_id, draft_id, draft_version, content_hash);
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'publication_operations'::regclass
       and conname = 'publication_operations_approved_revision_fk'
  ) then
    alter table publication_operations
      add constraint publication_operations_approved_revision_fk
      foreign key (
        approved_revision_id,
        project_id,
        draft_id,
        approved_draft_version,
        approved_content_hash
      )
      references draft_revisions (
        id,
        project_id,
        draft_id,
        draft_version,
        content_hash
      )
      on delete restrict;
  end if;
end
$$;

-- Fail closed if a partially managed database already contains conflicting
-- approved lineages. Never delete or rewrite publication history automatically.
do $$
declare
  duplicate_lineage record;
begin
  select project_id, draft_id, approved_revision_id, count(*) as operation_count
    into duplicate_lineage
    from publication_operations
   where approved_revision_id is not null
   group by project_id, draft_id, approved_revision_id
  having count(*) > 1
   limit 1;

  if found then
    raise exception
      'publication_approved_revision_duplicate: project_id=%, draft_id=%, approved_revision_id=%, count=%',
      duplicate_lineage.project_id,
      duplicate_lineage.draft_id,
      duplicate_lineage.approved_revision_id,
      duplicate_lineage.operation_count
      using errcode = '23505';
  end if;
end
$$;

create unique index if not exists publication_operations_approved_revision_uniq
  on publication_operations (project_id, draft_id, approved_revision_id)
  where approved_revision_id is not null;

-- Existing rows predate request fingerprinting and remain readable. Services replay
-- a legacy key only when the persisted identity proves equivalence; otherwise they
-- fail closed with an idempotency conflict.
alter table legal_visual_designs
  add column if not exists request_hash char(64);
alter table legal_video_scripts
  add column if not exists request_hash char(64);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'legal_visual_designs'::regclass
       and conname = 'legal_visual_designs_request_hash_check'
  ) then
    alter table legal_visual_designs
      add constraint legal_visual_designs_request_hash_check
      check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$');
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'legal_video_scripts'::regclass
       and conname = 'legal_video_scripts_request_hash_check'
  ) then
    alter table legal_video_scripts
      add constraint legal_video_scripts_request_hash_check
      check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$');
  end if;
end
$$;

-- Existing typography decisions predate full-intent fingerprinting. They remain
-- readable, but a legacy idempotency key cannot be replayed safely because the
-- original quote mode and selection intent were not persisted canonically.
alter table project_typography_runs
  add column if not exists request_hash char(64);

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'project_typography_runs'::regclass
       and conname = 'project_typography_runs_request_hash_check'
  ) then
    alter table project_typography_runs
      add constraint project_typography_runs_request_hash_check
      check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$');
  end if;
end
$$;

-- A confirmed stats snapshot must become visible from the monthly plan regardless
-- of which provider collector wrote it. The existing composite foreign key keeps
-- the link inside one post and project; this trigger only advances to the newest
-- snapshot and never rewrites campaign content.
create or replace function aurora_link_monthly_campaign_post_stats()
returns trigger
language plpgsql
as $$
begin
  update monthly_campaign_items item
     set latest_post_stats_id = new.id,
         updated_at = now()
   where item.project_id = new.project_id
     and item.post_id = new.post_id
     and (
       item.latest_post_stats_id is null
       or exists (
         select 1
           from post_stats previous
          where previous.id = item.latest_post_stats_id
            and (previous.snapshot_date, previous.id) < (new.snapshot_date, new.id)
       )
     );
  return new;
end
$$;

drop trigger if exists post_stats_link_monthly_campaign_after_write on post_stats;
create trigger post_stats_link_monthly_campaign_after_write
  after insert or update of views, reactions, reposts, comments, collected_at
  on post_stats
  for each row
  execute function aurora_link_monthly_campaign_post_stats();

-- Bring already collected snapshots into the same invariant without deleting or
-- changing historical statistics.
with latest as (
  select distinct on (stats.project_id, stats.post_id)
         stats.project_id, stats.post_id, stats.id
    from post_stats stats
   order by stats.project_id, stats.post_id, stats.snapshot_date desc, stats.id desc
)
update monthly_campaign_items item
   set latest_post_stats_id = latest.id,
       updated_at = now()
  from latest
 where item.project_id = latest.project_id
   and item.post_id = latest.post_id
   and item.latest_post_stats_id is distinct from latest.id;

-- ------------------------------------------------ Publication follow-up reliability

alter table publication_extra_operations
  add column if not exists requested_by_user_id bigint;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_extra_operations'::regclass
       and conname = 'publication_extra_operations_requested_by_user_id_fkey'
  ) then
    alter table publication_extra_operations
      add constraint publication_extra_operations_requested_by_user_id_fkey
      foreign key (requested_by_user_id) references users (id) on delete set null;
  end if;
end
$$;

alter table publication_review_tasks
  add column if not exists update_draft_id bigint;
alter table publication_review_tasks
  add column if not exists reminder_attempts integer not null default 0;
alter table publication_review_tasks
  add column if not exists reminder_provider_started_at timestamptz;
alter table publication_review_tasks
  add column if not exists reminder_last_error_code varchar(100);

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_review_tasks'::regclass
       and conname = 'publication_review_tasks_update_draft_project_fk'
  ) then
    alter table publication_review_tasks
      add constraint publication_review_tasks_update_draft_project_fk
      foreign key (update_draft_id, project_id)
      references drafts (id, project_id) on delete restrict;
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_review_tasks'::regclass
       and conname = 'publication_review_tasks_reminder_attempts_check'
  ) then
    alter table publication_review_tasks
      add constraint publication_review_tasks_reminder_attempts_check
      check (reminder_attempts >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_review_tasks'::regclass
       and conname = 'publication_review_tasks_reminder_delivery_check'
  ) then
    alter table publication_review_tasks
      add constraint publication_review_tasks_reminder_delivery_check
      check (
        (reminder_status = 'sending' and reminder_provider_started_at is not null)
        or reminder_status <> 'sending'
      );
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'publication_review_tasks'::regclass
       and conname = 'publication_review_tasks_update_draft_check'
  ) then
    alter table publication_review_tasks
      add constraint publication_review_tasks_update_draft_check
      check (
        (status = 'completed' and decision = 'update' and update_draft_id is not null)
        or (not (status = 'completed' and decision = 'update') and update_draft_id is null)
      ) not valid;
  end if;
end
$$;

create unique index if not exists publication_review_tasks_update_draft_uniq
  on publication_review_tasks (project_id, update_draft_id)
  where update_draft_id is not null;

create table if not exists publication_review_reminder_outbox (
  id                bigint generated always as identity primary key,
  project_id        bigint not null references projects (id) on delete cascade,
  review_task_id    bigint not null,
  recipient_user_id bigint not null references users (id) on delete restrict,
  job_key           char(64) not null,
  status            text not null default 'pending',
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  last_error_code   varchar(100),
  lease_token       char(64),
  lease_expires_at  timestamptz,
  enqueued_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint publication_review_reminder_outbox_task_project_fk
    foreign key (review_task_id, project_id)
    references publication_review_tasks (id, project_id) on delete cascade,
  constraint publication_review_reminder_outbox_job_key_check
    check (job_key ~ '^[0-9a-f]{64}$'),
  constraint publication_review_reminder_outbox_status_check
    check (status in ('pending','dispatching','enqueued','running','completed','failed','cancelled')),
  constraint publication_review_reminder_outbox_attempts_check check (attempts >= 0),
  constraint publication_review_reminder_outbox_lease_check check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  ),
  unique (project_id, review_task_id),
  unique (job_key)
);

create index if not exists publication_review_reminder_outbox_due_idx
  on publication_review_reminder_outbox (next_attempt_at, id)
  where status in ('pending','failed','enqueued');

-- ------------------------------------------------ Universal competitor sources

alter table competitors drop constraint if exists competitors_network_check;
alter table competitors drop constraint if exists competitors_status_check;
alter table competitors add column if not exists custom_title varchar(120);
alter table competitors add column if not exists avatar_url text;
alter table competitors add column if not exists external_id text;
alter table competitors add column if not exists connection_method text;
alter table competitors add column if not exists is_active boolean not null default true;
alter table competitors add column if not exists sync_requested_at timestamptz;
alter table competitors add column if not exists sync_started_at timestamptz;
alter table competitors
  add constraint competitors_status_check
  check (status in ('pending','refreshing','ready','error','no_feed','paused')) not valid;
alter table competitors validate constraint competitors_status_check;

alter table competitor_posts alter column tg_msg_id drop not null;
alter table competitor_posts add column if not exists external_post_id text;
alter table competitor_posts add column if not exists permalink text;
alter table competitor_posts add column if not exists like_count integer;
alter table competitor_posts add column if not exists comments_count integer;
alter table competitor_posts add column if not exists thumbnail_url text;
update competitor_posts
   set external_post_id = tg_msg_id::text
 where external_post_id is null and tg_msg_id is not null;
create unique index if not exists competitor_posts_external_key
  on competitor_posts (competitor_id, external_post_id)
  where external_post_id is not null;
create index if not exists competitors_channel_active_idx
  on competitors (channel_id, is_active, network, collected_at);

-- ------------------------------------------------ Immutable Autopilot build inputs

alter table autopilot_plan add column if not exists generation_post_frequency smallint;
alter table autopilot_plan add column if not exists expected_post_count smallint;
alter table autopilot_plan add column if not exists build_activity_at timestamptz;
update autopilot_plan plan
   set generation_post_frequency = coalesce(
         (
           select least(30, greatest(1, settings.post_frequency))::smallint
             from autopilot_settings settings
            where settings.project_id = plan.project_id
              and settings.channel_id = plan.channel_id
            limit 1
         ),
         5
       )
 where generation_post_frequency is null;
update autopilot_plan
   set expected_post_count = least(
         90,
         greatest(1, generation_post_frequency) * greatest(1, planning_weeks)
       )::smallint
 where expected_post_count is null;
alter table autopilot_plan alter column generation_post_frequency set default 5;
alter table autopilot_plan alter column generation_post_frequency set not null;
alter table autopilot_plan alter column expected_post_count set default 5;
alter table autopilot_plan alter column expected_post_count set not null;
update autopilot_plan set build_activity_at = created_at where build_activity_at is null;
alter table autopilot_plan alter column build_activity_at set default now();
alter table autopilot_plan alter column build_activity_at set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'autopilot_plan'::regclass
       and conname = 'autopilot_plan_generation_post_frequency_check'
  ) then
    alter table autopilot_plan
      add constraint autopilot_plan_generation_post_frequency_check
      check (generation_post_frequency between 1 and 30);
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'autopilot_plan'::regclass
       and conname = 'autopilot_plan_expected_post_count_check'
  ) then
    alter table autopilot_plan
      add constraint autopilot_plan_expected_post_count_check
      check (expected_post_count between 1 and 90);
  end if;
end
$$;
