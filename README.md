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

Миграция `20260916_session_token_hashes.sql` переименовывает verifier в
`sessions.token_hash`, хеширует и инвалидирует старые строки. Это одноразовый общий logout,
не ручная ротация пользователей; после миграции в cookie остаётся сырой bearer, а в БД —
только SHA-256 verifier.

Ingress/reverse proxy обязан жёстко ограничивать body запроса аватара до значения
`AURORA_AVATAR_BODY_LIMIT_BYTES` (от 10 485 760 до 11 010 048 байт) и закрывать соединение
до передачи превышения в Next.js. В production переменная обязательна: startup/readiness
останавливает web при её отсутствии или значении вне диапазона. Route дополнительно читает
chunked multipart потоково с тем же пределом, не доверяет `Content-Length` и допускает не
более четырёх одновременных body в одном web-процессе.

Ingress также обязан добавлять клиентский адрес справа в `X-Forwarded-For`. Rate limiter
считает от правого края цепочки; для нескольких доверенных proxy задай точное
`AURORA_TRUSTED_PROXY_HOPS`. `X-Real-IP` игнорируется, пока оператор явно не включит его и
не гарантирует перезапись заголовка на ingress.

`APP_URL` — единственный доверенный origin для browser mutations. Cookie POST без `Origin`
принимается только с браузерным `Sec-Fetch-Site: same-origin`; cookie-less worker/service
requests проходят собственную route-аутентификацию и не зависят от CSRF-заголовков.

PostgreSQL pool больше не имеет неограниченного ожидания. В production задай общий
`AURORA_DB_POOL_MAX` либо отдельные `AURORA_DB_POOL_MAX_WEB` и
`AURORA_DB_POOL_MAX_WORKER` из утверждённого connection budget; без budget web/worker
и shared process fail-closed. Connection/query/statement/idle-transaction timeouts ограничены и могут быть
переопределены переменными из `.env.example`. Защищённый `/api/readiness` возвращает
`databasePool` с active/idle/waiting, acquire wait p95 и счётчиками acquire timeout/error;
это локальный signal, а не доказательство capacity или замена PgBouncer/load dashboard.

На платформе с отдельными типами процессов запускай `npm run start:web` для HTTP и
`npm run start:worker` для фонового воркера. Все production-переменные должны быть
внедрены самой платформой. Serverless-хостинг вроде Vercel подходит для web-процесса,
но воркер публикаций нужно держать на отдельном постоянно работающем сервисе.

Все HTML-страницы рендерятся динамически: `src/proxy.ts` создаёт новый CSP nonce для
каждого document request, а root layout привязывает к нему framework scripts. Поэтому
CDN/ISR-кеширование HTML намеренно отключено; capacity planning web-процесса должен
исходить из server-side rendering, а не из статической раздачи лендинга.

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
npm run test:e2e:stability    # 30 полных циклов Chromium/Firefox/WebKit с CI-доказательствами
```

Production build запускается с ограниченным V8 heap 4096 МБ: текущий объём проекта
превышает стандартный лимит Node 26 около 2144 МБ. Допустимое явное переопределение —
`AURORA_BUILD_MAX_OLD_SPACE_SIZE_MB=2048..8192`; невалидное значение останавливает build
до запуска Next.js. Repo-scoped временный lock не допускает две одновременные production
build одного checkout: Next.js изменяет общий generated type state, поэтому такая гонка
считается ошибкой, а не поддерживаемым ускорением. Real E2E удерживает этот lock до
завершения browser journey и teardown, поэтому другая сборка не может удалить его dist
или пересечься с disposable DB reset.

`test:e2e:real` требует выбранный `E2E_BROWSER=chromium|firefox|webkit`, OpenSSL, явно выделенную локальную базу
`aurora_e2e_real` в `E2E_DATABASE_URL` и Redis DB 15 в `E2E_REDIS_URL`. Harness сам
создаёт изолированную production-сборку, запускает release entrypoint (`next start` и
workers) за локальным HTTPS ingress и fail-closed отклоняет другие targets. Он пересоздаёт
свои fixtures без production-данных и принудительно отключает Sentry SDK, build telemetry
и source-map/release upload, очищая унаследованные Sentry credentials для дочерних процессов.
Harness пересоздаёт схему и очищает Redis, поднимает fake AI/Telegram, QA-пользователя и каналы, проверяет
критический browser journey, конкурентную запись настроек и завершает прогон при любом
first-party HTTP 5xx или необработанной runtime-ошибке. Команда не использует live secrets,
не публикует в Telegram и удаляет созданные данные.
Mocked contract suite сохранён отдельно как `npm run test:contracts`; он не считается E2E.
CI последовательно запускает один и тот же disposable critical journey во всех трёх
движках; artifacts разделены по имени движка. Chromium создаёт `.next-e2e-real`, а Firefox
и WebKit используют `E2E_BUILD_MODE=reuse`, который fail-closed требует непустые `BUILD_ID`
и `build-manifest.json`. Обычный запуск остаётся в режиме `build`; его десятиминутный лимит
можно явно изменить через `E2E_BUILD_TIMEOUT_MS` (от 60000 до 14400000 мс). Один зелёный
движок не закрывает gate.

`test:e2e:stability` последовательно выполняет 30 полных трёхдвижковых циклов (90 journey),
fail-fast останавливается на первом сбое и для каждого journey требует два Playwright trace,
не менее двух video, интерфейсные screenshots и непустой обезличенный network log. Файлы,
их размеры и SHA-256 фиксируются в итоговом `manifest.json` под уникальным каталогом
`test-results/e2e-stability/<timestamp>`. Там же сохраняется SHA-256 snapshot входных
файлов; изменение кода, схемы или runtime-конфигурации между journeys немедленно делает
gate красным. Во время production build snapshot проверяется каждые две секунды; при
изменении входов process group сборки останавливается, а точные пути попадают в ошибку.
Standalone journey повторно сверяет тот же snapshot перед зелёным `result.json`, поэтому
изменение source после build также не может получить зелёный статус.
Режим `E2E_BUILD_MODE=reuse` дополнительно требует, чтобы production build
был создан из точно такого же snapshot. Значение `E2E_STABILITY_RUNS=1..30` допускается
только для локальной проверки раннера; результат менее 30 циклов не закрывает release gate.
Ручной GitHub Actions workflow `E2E stability gate` всегда запускает ровно 30 циклов и
загружает весь каталог как CI artifact даже при fail-fast ошибке.

При нестабильных системных часах локально допускается только явный
`E2E_ADVANCE_SCHEDULE_AFTER_RESTART=1`: harness сначала доказывает сохранение единственного
delayed job и outbox через restart, затем переводит disposable fixture в due и продвигает
тот же job. CI и обычный запуск всегда используют реальное время.

После deployment запусти удалённый production gate:

```bash
AURORA_DEPLOYMENT_SMOKE_BASE_URL='https://app.example.com' \
AURORA_READINESS_TOKEN='replace-with-the-operator-secret' \
npm run test:deployment-smoke
```

Профиль `full` по умолчанию требует свежие liveness/readiness, готовность web, схемы,
publication worker, AI, почты, uploads, token keyring и tracking. Он также проверяет
security headers и привязку всех framework scripts/styles к response-specific CSP nonce
на `/` и `/bot`. Скрипт не следует redirect, принимает только публичный HTTPS origin без
credentials/query/hash и ограничивает размер ответов. В GitHub Actions тот же gate
запускается вручную workflow `Production deployment smoke` и автоматически после
workflow `Deploy production`. Защищаемое environment `production` должно содержать
variables `PRODUCTION_BASE_URL`, `REQUIRED_CI_CHECKS` и secrets
`AURORA_READINESS_TOKEN`, `PRODUCTION_SSH_HOST`, `PRODUCTION_SSH_USER`,
`PRODUCTION_SSH_KEY`, `PRODUCTION_SSH_KNOWN_HOSTS`,
`PRODUCTION_SSH_HOST_FINGERPRINT`. `REQUIRED_CI_CHECKS` — разделённый запятыми список
обязательных check-run names. При изменении migration manifest rollback разрешается только
после отдельного schema compatibility audit: защищённая variable `SCHEMA_ROLLBACK_AUDIT`
должна содержать точную пару `<previous-40-char-sha>:<target-40-char-sha>`.
DDL запускается отдельной database identity: через `AURORA_MIGRATION_DATABASE_URL` на
сервере или, только для root-operated single-host PostgreSQL, через явно включённую
protected variable `ALLOW_LOCAL_PEER_MIGRATIONS=true`. Runtime `DATABASE_URL` используется
лишь для проверки точного локального target и никогда не получает DDL-права.
Обычный релиз — `gh workflow run "Deploy production" --ref main`; агентам не
нужен SSH.
Полный порядок ledger audit, staging rehearsal, go/no-go и rollback описан в
[`docs/production-readiness-plan-2026-08-20.md`](docs/production-readiness-plan-2026-08-20.md).

Live Telegram smoke запускается отдельно и никогда не использует обычные
`TG_BOT_TOKEN`/`TG_CHAT_ID`. Для него нужны выделенные sandbox-бот и чат:

```bash
TG_SANDBOX_BOT_TOKEN='...' \
TG_SANDBOX_CHAT_ID='...' \
TG_SANDBOX_EXPECTED_BOT_USERNAME='sandbox_bot' \
AURORA_TELEGRAM_SANDBOX_SEND='I_UNDERSTAND_THIS_SENDS_A_REAL_TELEGRAM_MESSAGE' \
npm run test:telegram-sandbox
```

Для Telegram Business также задаются `TG_SANDBOX_BUSINESS_CONNECTION_ID` и
`TG_SANDBOX_EXPECTED_BUSINESS_USER_ID`: smoke сначала проверит владельца connection,
затем отправит ровно одно silent-сообщение с маркером `[AURORA SANDBOX]`. Команда
аварийно завершается до отправки, если отсутствует явное подтверждение, sandbox-токен
или chat ID совпадает с доступной процессу обычной конфигурацией либо identity бота не
совпала с `TG_SANDBOX_EXPECTED_BOT_USERNAME`. В GitHub Actions тот же сценарий доступен
только вручную через workflow `Telegram sandbox smoke` и защищаемое environment
`telegram-sandbox`.

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
| `/app/radar` | А8 | Публичный OSINT-поиск: люди, бренды, сайты, Telegram, публикации и тренды |
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

Protected `GET /api/readiness` distinguishes process liveness, PostgreSQL reachability, exact schema
compatibility, Redis, publication worker heartbeat, observed AI provider health and password
reset delivery. A reachable legacy database returns HTTP 503. Missing mail configuration does
not stop draft/web work, but the response remains `degraded` and
`passwordRecoveryReady=false`; production must not claim password recovery is available until
`APP_URL`, a delivery key and a sender are configured.

Отчёт доступен только подтверждённой глобальной admin session или с
`Authorization: Bearer $AURORA_READINESS_TOKEN`; hostname, loopback-адрес и forwarded
headers не дают авторизацию. Любой другой запрос получает 401 до запуска dependency
probes. Без авторизации открыт только минимальный `/api/health`. Локальный и post-deploy
monitoring используют тот же operator token.

Readiness также проверяет, что каждый сохранённый `v1` token envelope ссылается на key ID,
доступный в текущем write/read keyring. Неизвестный ID блокирует publication readiness до
восстановления ключа; порядок безопасной ротации описан в `docs/token-key-rotation.md`.
