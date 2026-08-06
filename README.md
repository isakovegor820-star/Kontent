# Аврора

Лендинг + платформа автопостинга с разведкой конкурентов, поиском залетающих тем и ИИ-автопилотом.
Собрано по ТЗ v2.0 от 14 июля 2026.

## Локальный запуск

```bash
npm install
cp .env.example .env.local
npm run dev      # web + worker, http://localhost:3000
```

`npm run dev` сам проверяет локальные PostgreSQL и Redis, при необходимости запускает
их через Homebrew, создаёт отсутствующую локальную базу и её bootstrap-схему, применяет
миграции и только после этого поднимает web + полный worker. Для ИИ укажи хотя бы один
облачный ключ в `.env.local` или запусти Ollama; полный список переменных и пояснения
находятся в `.env.example`.

## Production

```bash
npm ci
npm run test:migrations
npm run db:migrate
npm run build
npm start        # Next.js + постоянно работающий BullMQ worker
```

`db/schema.sql` — только bootstrap-снимок для новой пустой базы; его нельзя использовать
как upgrade-команду на живых данных. Существующую базу обновляет только `npm run db:migrate`:
runner заранее проверяет additive policy и транзакционную оболочку, сверяет checksum,
берёт неблокирующий advisory lock и отказывается работать, если базовая схема ещё не создана.
Миграции запускай отдельным release-step до старта web/worker; при ошибке деплой нужно
остановить, а не продолжать со старой схемой.

Ingress/reverse proxy обязан жёстко ограничивать body запроса аватара до значения
`AURORA_AVATAR_BODY_LIMIT_BYTES` (от 5 242 880 до 5 767 168 байт) и закрывать соединение
до передачи превышения в Next.js. В production переменная обязательна: startup/readiness
останавливает web при её отсутствии или значении вне диапазона. Route дополнительно читает
chunked multipart потоково с тем же пределом, не доверяет `Content-Length` и допускает не
более четырёх одновременных body в одном web-процессе.

На платформе с отдельными типами процессов запускай `npm run start:web` для HTTP и
`npm run start:worker` для фонового воркера. Все production-переменные должны быть
внедрены самой платформой. Serverless-хостинг вроде Vercel подходит для web-процесса,
но воркер публикаций нужно держать на отдельном постоянно работающем сервисе.

Для изолированной обработки только адресных Telegram-публикаций используй
`npm run worker:publication`. Этот режим не запускает RSS, cron, Autopilot, сбор
статистики, media jobs или bot polling и поэтому подходит для контролируемого smoke-test.

## Проверка релиза

```bash
npm run test:migrations
npm run test:focus
npm run lint
npx tsc --noEmit
npm test
npm run build
npm run build                 # повторный build без зависшего lock
npm run test:e2e:real         # production web + PostgreSQL + Redis + publication worker
```

`test:e2e:real` требует уже собранный production build, Chromium, явно выделенную локальную
базу `aurora_e2e_real` в `E2E_DATABASE_URL` и Redis DB 15 в `E2E_REDIS_URL`. Harness
fail-closed отклоняет другие targets, пересоздаёт схему и очищает Redis, поднимает fake
AI/Telegram, QA-пользователя и каналы, проверяет критический browser journey и удаляет
созданные данные. Команда не использует live secrets и не публикует в Telegram.
Mocked contract suite сохранён отдельно как `npm run test:contracts`; он не считается E2E.

## Что внутри

| Маршрут | Экран ТЗ | Что делает |
|---|---|---|
| `/` | А1 | Лендинг: 6 секций по ТЗ 8.1 + FAQ. Живое демо, лист ожидания |
| `/register` | А2 | Реальные регистрация/вход по email и паролю + восстановление |
| `/app/onboarding` | А3 | Мастер: бриф → реальный Telegram-канал → профиль → конкуренты |
| `/app/calendar` | А4 | **Главный экран.** Неделя/месяц, пост кликом в день, очередь без дат |
| `/app/composer` | А5 | Редактор: ИИ напиши/перепиши/сократи, предпросмотр TG и VK рядом |
| `/app/recon` | А6 | Гибридный поиск проверенных Telegram-каналов, постов и трендов по любой теме |
| `/app/competitors` | А6 | Карточки конкурентов: рост, активность, последний залёт |
| `/app/competitors/[id]` | А7 | Досье: статистика, лучшие посты, темы, упоминания, реклама, сравнение |
| `/app/trends` | А8 | Тренды: что залетает, почему, готовый сценарий |
| `/app/studio` | А9 | ИИ-студия: диалог + быстрые команды, память стиля |
| `/app/autopilot` | А10 | План на неделю, «одобрить всё» одной кнопкой |
| `/app/analytics` | А11 | Графики + человеческие выводы |
| `/app/settings` | А12 | Реальные сети, бот, автопилот и серверный лимит ИИ |

## Стек

- **Next.js 16** (App Router; production build через webpack) + React 19
- **Tailwind CSS v4** — токены через `@theme inline`, тёмная тема через `@custom-variant dark`
- **Motion** (Framer Motion 12) — все четыре уровня анимаций из ТЗ 7.4
- **Lucide** — единый набор иконок, линия 1.5–2px
- **PostgreSQL** — аккаунты, каналы, контент, аналитика и база знаний
- **Redis + BullMQ** — публикации по расписанию, сбор статистики, разведка и автопилот
- **Telegram/VK API** — подключение каналов и реальные публикации; OAuth-сети пока
  fail-closed и не предлагаются до готовности Composer
- **NavyAI/OpenAI/Anthropic/Gemini/Ollama** — ИИ-студия и генерация контента

## Дизайн-система «Aurora Glass»

Liquid Glass + Bento + Oversized Typography на светлой основе.
Характер по ТЗ 7.1 — «строгий инструмент, который умеет улыбаться»: рабочие экраны
спокойные, яркость появляется в моменты ценности (залёт, готовый план, хороший отчёт).

### Токены

Все цвета — CSS-переменные в `src/app/globals.css`. Ничего не хардкодится.

| Роль | Значение | Tailwind |
|---|---|---|
| Фирменный градиент | `#6366F1 → #8B5CF6` | `bg-brand-gradient`, `text-gradient` |
| Фон / секции | `#FFFFFF` / `#F8FAFC` | `bg-bg`, `bg-bg-section` |
| Текст / вторичный | `#0F172A` / `#64748B` | `text-text`, `text-text-2` |
| Успех | `#10B981` | `text-success`, `bg-success-soft` |
| Тревога | `#EF4444` | `text-danger`, `bg-danger-soft` |
| Залёт / огонь | `#F59E0B` | `text-fire`, `bg-fire-soft` |

**Правило одного магнита:** на экране одновременно не больше одного градиентного
элемента. Градиент = главное действие.

### Фон

Фирменная «аврора» — `src/components/aurora-background.tsx`: четыре дрейфующих
пятна света + строгая сетка-скелет + плёночное зерно. Всё на CSS-трансформах, ни одной
картинки — фон весит 0 КБ и не создаёт layout shift. Интенсивность: `hero` (лендинг) →
`section` → `app` (рабочие экраны, почти незаметно).

### Анимации (ТЗ 7.4)

1. **Микро** — 150–250 мс: отклик на каждое действие, скелетоны загрузки
2. **Скролл** — 400–600 мс: секции лендинга оживают, каждый элемент один раз
3. **Живое демо** — `src/components/landing/live-demo.tsx`: 20-секундный цикл
   разведка → ИИ печатает → пост в календарь → уходит в TG/VK → тикают просмотры.
   Это вёрстка, а не видео
4. **3D** — лёгкий параллакс только в hero

Потолок 600 мс в рабочем интерфейсе. `prefers-reduced-motion` уважается везде.

### Тёмная тема

ТЗ ставит её во вторую очередь, но требует «проектировать палитру сразу переменными».
Переменные готовы — тема работает уже сейчас (переключатель в шапке и футере).

## Структура

```
src/
  app/                    маршруты
  components/
    aurora-background.tsx фирменный фон
    brand.tsx             логотип, переключатель темы
    landing/              секции лендинга
    app/shell.tsx         каркас платформы (сайдбар, нижняя навигация)
    ui/                   кнопка, поля, карточки, тосты
  lib/
    types.ts              доменная модель
    db.ts                 PostgreSQL-пул
    queue.ts              очереди BullMQ
    ai-provider.ts        единый слой ИИ-провайдеров
    utils.ts              формат чисел, дат, русская плюрализация
worker.mjs                публикации, аналитика, разведка, автопилот и cron
db/schema.sql             воспроизводимая схема PostgreSQL
```

## Release readiness policy

`npm start` and the full worker perform a read-only schema preflight before creating HTTP
listeners, Redis/BullMQ consumers, worker heartbeat, cron, reconciliation or Telegram polling.
Local `npm run dev` additionally bootstraps an empty loopback database and applies migrations;
remote databases remain read-only during dev startup. The expected migration names/checksums
and required capabilities live in `src/lib/schema-manifest.mjs`. Production schema changes are
never applied from a request or worker startup path; run the separately controlled migration
command during deployment.

`GET /api/readiness` distinguishes process liveness, PostgreSQL reachability, exact schema
compatibility, Redis, publication worker heartbeat, observed AI provider health and password
reset delivery. A reachable legacy database returns HTTP 503. Missing mail configuration does
not stop draft/web work, but the response remains `degraded` and
`passwordRecoveryReady=false`; production must not claim password recovery is available until
`APP_URL`, a delivery key and a sender are configured.

Readiness также проверяет, что каждый сохранённый `v1` token envelope ссылается на key ID,
доступный в текущем write/read keyring. Неизвестный ID блокирует publication readiness до
восстановления ключа; порядок безопасной ротации описан в `docs/token-key-rotation.md`.
