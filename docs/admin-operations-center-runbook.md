# Операционный центр `/admin`

## Доступ и граница безопасности

Операционный центр доступен только live session из глобального allowlist
`AURORA_ADMIN_USER_IDS` / `AURORA_ADMIN_EMAILS`. Проектная роль owner сама по себе не
даёт доступ. Оба API read-only, rate-limited, возвращают `Cache-Control: no-store` и
пишут content-free запись в `admin_observation_events`.

Запрещённые действия намеренно отсутствуют: restart, очистка Redis, массовый retry,
запуск миграций, изменение env и удаление событий.

## Действия над аккаунтом

`POST /api/admin/users/:id/actions` — `block` / `unblock`, `revoke_sessions`,
`send_password_reset`, `set_ai_limit`. Блокировка и завершение сессий поворачивают
`users.credential_epoch`, поэтому все живые сессии умирают в той же транзакции;
`getSessionUser` дополнительно отвергает `blocked_at is not null`. Сброс пароля идёт
через штатный `password_reset_outbox` — админ не видит токен. `ai_daily_limit`
переопределяет `AI_DAILY_LIMIT` для одного аккаунта (1–100 000, `null` — платформенный).
Нельзя заблокировать себя и аккаунты из admin allowlist. Журнал —
`admin_account_actions` (миграция `20261009_admin_account_controls.sql`).

## Telegram-алерты администраторам

`src/lib/admin-alerts-scheduler.ts` стартует из `instrumentation.ts` только в web-процессе
(воркер не может сообщить о собственной смерти). Раз в `AURORA_ADMIN_ALERTS_INTERVAL_MS`
(5 мин) проверяются PostgreSQL, Redis, heartbeat воркера публикаций, Telegram-polling и
число просроченных публикаций. Сообщение уходит один раз при переходе в сбой, повтор раз
в `AURORA_ADMIN_ALERTS_REPEAT_MS`, и один раз при восстановлении. Получатели — только
`AURORA_ADMIN_USER_IDS` / `AURORA_ADMIN_EMAILS` с привязанным `tg_chat_id`.
Выключить: `AURORA_ADMIN_ALERTS=off`.

## «Проекты»

URL: `/admin?prq=&prstatus=&prnetwork=&prsort=&prpage=&prid=<id>#projects`.
`GET /api/admin/projects` — список тенантов с владельцем, командой, каналами,
публикациями за период, автопилотом и состоянием бота; фильтры `all / attention /
active / inactive / team / personal / archived`. `GET /api/admin/projects/:id` — карточка:
участники (ссылки на аккаунты), каналы, последние публикации, журнал проекта, динамика.
Ключ `prid` намеренно отличается от `project` (фильтр аналитики). Раздел read-only.

## «Публикации»

URL: `/admin?pq=&pstatus=&pnetwork=&pproject=&perror=&psort=&ppage=#publications`.

`GET /api/admin/publications` — поиск по ID/тексту/проекту/каналу/автору, фильтры по
состоянию (`attention` по умолчанию), сети, проекту и коду ошибки, серверная пагинация.
`POST /api/admin/publications/actions` — точечные действия над одной публикацией:

- `retry` — только `failed` / `quarantined` / `failed_retry`: пост возвращается в
  `scheduled` с `scheduled_at = now()` и новой `schedule_revision`, job ставится сразу;
- `reschedule` — то же, но на указанное время (не раньше текущего, не дальше года);
- `cancel` — `scheduled` / `failed_retry` / `failed` / `quarantined` → `cancelled`.

Все три отказывают, если `publish_lease_token` установлен (провайдер вызывается прямо
сейчас), и пишут `audit_events` с `publication.admin.*`, `from/to`, ревизией и request ID.
Канал в состоянии `needs_reconnect` блокирует retry/reschedule: сначала владелец должен
переподключить канал.

## «Система»

URL: `/admin?system=<component>#system`.

Каждая из 15 независимых проверок возвращает `state`, `checkedAt`, `durationMs`,
`evidence`, `safeErrorCode`, `lastSuccessAt`. Probes запускаются через
`Promise.allSettled`; один отказ не скрывает остальные. Допустимы только состояния
`healthy`, `degraded`, `down`, `unobserved`, `not_configured`, `configured`, `conflict`.
Healthy требует свежего успешного доказательства. `configured` означает, что проверена
только конфигурация (наличие секретов, схема origin, лимит ingress) — такие компоненты
не считаются ни исправными, ни предупреждениями.

Релиз (`AURORA_RELEASE`, `AURORA_RELEASE_SHA`, `AURORA_DEPLOYED_AT`) записывается в
`.env.production` скриптом `scripts/deploy-production.sh` на каждом деплое; browser-версия
`NEXT_PUBLIC_AURORA_APP_VERSION` задаётся на этапе сборки в workflow.

При инциденте:

1. Откройте красную/жёлтую карточку и проверьте evidence, возраст heartbeat/PING и safe code.
2. Для очереди сравните workers, waiting/active/delayed/failed и возраст старейшей задачи.
3. Перейдите по безопасной ссылке в публикации, журнал или затронутый раздел.
4. Скопируйте request ID из аналитики и используйте его в logs/Sentry без поиска по контенту.
5. Не трактуйте `unobserved` или `not_configured` как подтверждённый healthy.

Ручное обновление всегда доступно; автообновление выключено, 30 секунд или 1 минута.
Back/forward и reload сохраняют выбранный компонент.

## «Аналитика Авроры»

URL: `/admin?<filters>&analyticsSection=<section>&analyticsTab=<tab>#aurora-analytics`.

Карточки строятся для всех разделов из `APP_ROUTES` (сейчас 16). Активность, техническое
здоровье и полезный доменный результат разделены. Фильтры: 24h/7d/30d/custom,
project, role segment, new/returning, device, app version и release. Если доменная
таблица не содержит выбранное измерение device/version/release, результат маркируется
`not_filterable` и не приписывается фильтру.

Вкладки:

- «Обзор»: сравнение периода, p50 до completed result, проблемы и релизы.
- «Воронка»: opening → action → server confirmation → domain result → further use.
- «Ошибки»: safe code, stage/source, affected users/projects, request ID, release,
  dependency и опциональная Sentry search link.
- «Скорость»: p50/p95/p99 по operation kind/release и отдельный SLO для page/API/
  queue/worker/provider.
- «События»: максимум 100 allowlisted raw rows без metadata dump и контента.

Рейтинг использует только прозрачные правила `affectedUsers × frequency × severity`.
Он выделяет рост ошибок, provider/release regression, падение conversion, page SLO,
действия без доменного результата и latest non-terminal stage старше 15 минут.

## Источники product events

- Браузер (`src/components/app/aurora-product-telemetry.tsx`): открытие раздела
  (`loaded`), клики по `data-aurora-action`, runtime-ошибки UI.
- Сервер (`src/lib/server-product-events.mjs`, общий для web и worker):
  - `calendar/publication/scheduled` — `accepted` из `POST /api/posts/create`,
    затем `completed|retried|failed` из publish-воркера с `queue`, `attempt`
    и безопасным `errorCode`;
  - `studio/generation/requested|result_received` — из `POST /api/ai/generate`;
  - `autopilot/plan/approved` — из `POST /api/autopilot/approve`.

Серверные события никогда не содержат текст, промпты, причины ошибок или payload
провайдера: `errorCode` проходит через `safeProductErrorCode`, tenant берётся из
доменной строки. Эмиттер best-effort: сбой записи логируется и не меняет исход
доменной операции.

## Конфигурация

- `AURORA_RELEASE`, `AURORA_RELEASE_SHA`, `AURORA_DEPLOYED_AT` — server release marker.
- `NEXT_PUBLIC_AURORA_APP_VERSION` — безопасная browser version dimension.
- `AURORA_PRODUCT_EVENT_RETENTION_DAYS` — raw retention, 7–365, default 90.
- `SENTRY_ORG_SLUG`, `SENTRY_PROJECT_ID` — только построение validated issue-search URL;
  auth token и stack traces в API не передаются.

## Проверки перед выпуском

```text
npm run test:migrations
npx tsc --noEmit
npm test
npm run lint
npm run build
```

PostgreSQL integration выполняется только на локальной disposable базе
`aurora_migration_test`; real E2E — через `npm run test:e2e:real` с изолированными
E2E_DATABASE_URL/E2E_REDIS_URL. Production deploy выполняется только существующим
GitHub Actions workflow.
