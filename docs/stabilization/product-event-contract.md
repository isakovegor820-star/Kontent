# Product event contract операционного центра

Статус: технический operational-контур реализован. Исполняемый allowlist находится в
`src/lib/product-event-contract.mjs`, каталог разделов и SLO — в
`src/lib/aurora-section-catalog.ts`. Это не означает закрытие BLK-04: минимальная
taxonomy раздела 9.1 пока не связана с production lifecycle emitters, а 95% synthetic
reconciliation, consent/DPA approval и freshness/volume alerts не подтверждены.

## Назначение источников

- `product_events` описывает открытие, начало и безопасные стадии пользовательского пути.
- Доменные таблицы подтверждают бизнес-результат. Нажатие кнопки не считается успехом.
- `product_event_daily` хранит долгосрочные счётчики без `safe_context` и контента.
- Sentry остаётся источником stack traces; PostgreSQL хранит только safe error code и correlation ID.
- readiness/heartbeat отвечают за инфраструктурное здоровье, audit journals — за изменения.

## Server-owned envelope

Клиент может передать только валидированные `eventId`, `sectionId`, `featureId`,
`action`, `stage`, `outcome`, `durationMs`, `errorCode`, `requestId`, `operationId`,
`sessionId`, `occurredAt` и `safeContext`. Поле `important` вычисляет валидатор из
`stage`/`outcome`/`errorCode`; присланное клиентом значение отклоняется.

`user_id`, `project_id` и release metadata выбирает сервер после проверки live session
и активного membership. Присланные клиентом `userId`, `projectId` или `release`
отклоняются. Идемпотентность обеспечивается уникальным ключом
`(project_id, user_id, event_id)`.

## Privacy и ограничения

- Неизвестные section/feature/action/stage/outcome и свойства отклоняются fail-closed.
- `safeContext` принимает только bounded scalar-поля `device`, `source`,
  `operationKind`, `appVersion`, `queue`, `httpStatus`, `attempt`, `resultKind`.
- Nested object/array, email-like значения, абсолютные URL, bearer/token-like значения,
  PII и пользовательский контент отклоняются.
- Error codes ограничены `^[a-z0-9_]{1,100}$`; request/operation correlation —
  безопасным bounded identifier.
- Ingestion требует same-origin, live session и active tenant membership, ограничивает
  body 64 KiB, batch 50 событий и использует fail-closed rate limit.
- Admin analytics возвращает только safe codes, pseudonymous numeric refs, request ID,
  release и allowlisted context dimensions; тексты, prompts, provider responses, cookie,
  Authorization и секретные URL не сериализуются.

## Retention и агрегаты

Raw retention задаётся `AURORA_PRODUCT_EVENT_RETENTION_DAYS`, допустимо 7–365 дней,
по умолчанию 90. Удаление выполняется bounded batches; ежедневные агрегаты остаются.
Raw timeline ограничен 100 строками на запрос, аналитический период — максимум 90 дней.

## Browser instrumentation

`AuroraProductTelemetry` монтируется в `/app`, сопоставляет aliases с ровно 15
разделами `APP_ROUTES`, измеряет реальную загрузку route, пакетирует обычные события и
немедленно отправляет важные ошибки. Делегированные `data-aurora-feature` /
`data-aurora-action` отмечают начало основных сценариев. Runtime errors сохраняются
только как `ui_runtime_error` без message/stack/content.

## Проверка

Контракт покрыт allowlist/PII/deduplication/tenant/rate-limit/no-store тестами,
migration policy, transaction integration на PostgreSQL и real E2E ingestion. При
отсутствии наблюдений UI показывает «нет данных», а не ноль, demo metric или зелёный
статус.
