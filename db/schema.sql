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

-- Одноразовые коды входа по почте (email_codes): таблица была заложена под вход по кодам,
-- но дизайн заменили на пароль (scrypt) и вход через Telegram/VK ID — кодом таблицу не
-- использовал НИ ОДИН. Мёртвая схема путает при чтении, поэтому убираем: на новых базах
-- она просто не создаётся, а на уже живых — сносим её при повторном накате файла.
drop table if exists email_codes;


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
  provider_job_id  text,
  output_asset_id  bigint references media_assets (id) on delete set null,
  error_code       text,
  error_message    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create index if not exists media_generations_user_idx on media_generations (user_id, created_at desc);
create index if not exists media_generations_active_idx on media_generations (status, updated_at)
  where status in ('queued','submitting','generating','saving');


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
-- канал, и пишет наугад. Один бриф на аккаунт — как и настроение агента.
-- source: чем заполнен — 'ai' (платформа прочитала канал и предложила) или 'manual'.
-- Честность: ready ставит только сам пользователь, подтвердив бриф глазами.
create table if not exists content_brief (
  user_id    bigint      primary key references users (id) on delete cascade,
  niche      text,                    -- о чём канал (обязательно)
  audience   text,                    -- для кого (обязательно)
  rubrics    text[]      not null default '{}',  -- рубрики/форматы, которые чередуем
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
  subscribers  int,
  posts        int,                            -- сколько постов видно на публичной странице
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


-- =================================== Д.9+: автопилот и бриф — НА КАНАЛ, а не на юзера
-- Было: autopilot_settings.user_id и content_brief.user_id — PRIMARY KEY, то есть одни
-- настройки и один бриф на человека. А в autopilot_plan канала не было вообще. Семь мест
-- в коде брали канал запросом «...is_active limit 1» БЕЗ order by — то есть при двух
-- каналах автопилот молча выбирал один (какой — Postgres не гарантирует) и писал туда
-- посты по брифу другого. У первого же пользователя с двумя каналами второй не получал
-- ничего. Теперь ключ — пара (пользователь, канал): у каждого канала свои настройки,
-- свой бриф и свой план.

alter table autopilot_settings add column if not exists channel_id bigint references channels (id) on delete cascade;
alter table content_brief      add column if not exists channel_id bigint references channels (id) on delete cascade;
alter table autopilot_plan     add column if not exists channel_id bigint references channels (id) on delete cascade;

-- Переносим существующие строки на первый канал владельца: это то, чем автопилот и так
-- пользовался де-факто (limit 1 → минимальный id), только теперь это записано явно.
update autopilot_settings s set channel_id = (select min(c.id) from channels c where c.user_id = s.user_id and c.network = 'tg') where s.channel_id is null;
update content_brief      b set channel_id = (select min(c.id) from channels c where c.user_id = b.user_id and c.network = 'tg') where b.channel_id is null;
update autopilot_plan     p set channel_id = (select min(c.id) from channels c where c.user_id = p.user_id and c.network = 'tg') where p.channel_id is null;

-- Строки без канала осмысленны быть не могут: настройки автопилота для несуществующего
-- канала — мусор, который сломает новый ключ.
delete from autopilot_settings where channel_id is null;
delete from content_brief      where channel_id is null;
delete from autopilot_plan     where channel_id is null;

alter table autopilot_settings alter column channel_id set not null;
alter table content_brief      alter column channel_id set not null;
alter table autopilot_plan     alter column channel_id set not null;

alter table autopilot_settings drop constraint if exists autopilot_settings_pkey;
alter table content_brief      drop constraint if exists content_brief_pkey;
alter table autopilot_settings add primary key (user_id, channel_id);
alter table content_brief      add primary key (user_id, channel_id);

-- План ищут по каналу и свежести — индекс под это.
create index if not exists autopilot_plan_channel_idx on autopilot_plan (channel_id, created_at desc);

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

delete from autopilot_settings     where channel_id is null;
delete from content_brief          where channel_id is null;
delete from autopilot_plan         where channel_id is null;
delete from competitors            where channel_id is null;
delete from competitor_suggestions where channel_id is null;

alter table autopilot_settings     alter column channel_id set not null;
alter table content_brief          alter column channel_id set not null;
alter table autopilot_plan         alter column channel_id set not null;
alter table competitors            alter column channel_id set not null;
alter table competitor_suggestions alter column channel_id set not null;

alter table autopilot_settings drop constraint if exists autopilot_settings_pkey;
alter table content_brief      drop constraint if exists content_brief_pkey;
alter table autopilot_settings add primary key (user_id, channel_id);
alter table content_brief      add primary key (user_id, channel_id);

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


-- ==================================================== Wave 2: RSS-репостер
-- Юзер добавляет RSS/Atom-ленту → воркер по cron парсит → ИИ суммаризирует → пост в очередь.
create table if not exists rss_feeds (
  id              bigint generated always as identity primary key,
  user_id         bigint      not null references users (id) on delete cascade,
  channel_id      bigint      not null references channels (id) on delete cascade,
  url             text        not null,
  title           text,
  is_active       boolean     not null default true,
  ai_summarize    boolean     not null default true,
  max_per_day     int         not null default 3,
  last_fetched_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (user_id, url)
);
create index if not exists rss_feeds_user_idx on rss_feeds (user_id);

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
  fetched_at   timestamptz not null default now(),
  unique (feed_id, guid)
);
create index if not exists rss_items_feed_idx on rss_items (feed_id, fetched_at desc);

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

-- ── Мониторинг упоминаний MVP (Track 6) ────────────────────────────────────────
create table if not exists mention_queries (
  id              bigint generated always as identity primary key,
  user_id         bigint not null references users (id) on delete cascade,
  channel_id      bigint not null references channels (id) on delete cascade,
  keyword         text   not null,
  networks        text[] not null default '{tg,vk}',
  is_active       boolean not null default true,
  last_checked_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (channel_id, keyword)
);

create table if not exists mentions (
  id            bigint generated always as identity primary key,
  query_id      bigint not null references mention_queries (id) on delete cascade,
  network       text   not null check (network in ('tg', 'vk')),
  source_handle text,
  source_title  text,
  post_url      text,
  text          text,
  author        text,
  posted_at     timestamptz,
  notified      boolean not null default false,
  found_at      timestamptz not null default now(),
  unique (query_id, network, post_url)
);
create index if not exists mentions_query_idx on mentions (query_id, found_at desc);

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
