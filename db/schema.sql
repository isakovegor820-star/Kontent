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
  vk_group_id bigint,          -- id сообщества VK (для network='vk')
  vk_token    text,            -- токен сообщества VK в виде AES-GCM-конверта (см. src/lib/token-crypto.mjs), никогда не plaintext
  title       text,
  handle      text,
  is_active   boolean     not null default true,
  created_at  timestamptz not null default now()
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

create unique index if not exists channels_vk_group_active_uniq
  on channels (vk_group_id)
  where vk_group_id is not null and is_active;

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
  data             bytea       not null,
  sha256           text        not null,
  duration_seconds int,
  created_at       timestamptz not null default now()
);
create index if not exists media_assets_user_idx on media_assets (user_id, created_at desc);

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
  -- Подключение источника не запускает публикацию без отдельного подтверждения.
  is_active       boolean     not null default false,
  ai_summarize    boolean     not null default true,
  publish_existing boolean    not null default false,
  max_per_day     int         not null default 3,
  last_fetched_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (user_id, url)
);
create index if not exists rss_feeds_user_idx on rss_feeds (user_id);
alter table rss_feeds add column if not exists publish_existing boolean not null default false;

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
  media         jsonb,
  scheduled_at  timestamptz,
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
  destination_ids  jsonb not null,
  options           jsonb not null default '{}'::jsonb,
  status            text not null default 'pending'
                    check (status in ('pending','partial','queued','published_unverified','published','failed')),
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
create unique index if not exists posts_publication_operation_destination_uniq
  on posts (publication_operation_id, channel_id) where publication_operation_id is not null;
create table if not exists publication_outbox (
  id               bigint generated always as identity primary key,
  operation_id     bigint not null references publication_operations (id) on delete cascade,
  post_id           bigint not null references posts (id) on delete cascade,
  status            text not null default 'pending'
                    check (status in ('pending','dispatching','enqueued','failed')),
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
    'missing', 'deleted_external', 'failed_retry', 'quarantined', 'failed'
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
