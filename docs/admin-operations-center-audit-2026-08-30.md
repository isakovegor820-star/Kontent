# Аудит операционного центра `/admin`

Дата: 30 августа 2026 года. Статус: аудит завершён; архитектура реализована и проверяется как единый операционный контур.

## 1. Что уже существует

### Доступ и интерфейс администратора

- `/admin` уже защищён серверным allowlist `AURORA_ADMIN_USER_IDS` / `AURORA_ADMIN_EMAILS` в `src/lib/admin-access.ts`. Роли внутри клиентского проекта не дают глобальный доступ.
- Текущий клиентский экран находится в `src/components/admin/admin-dashboard.tsx`; раздел «Система» содержит четыре некликабельные карточки PostgreSQL, Redis, воркера публикаций и Aurora AI.
- `/api/admin/overview` уже проверяет сессию и глобальный admin allowlist и возвращает `Cache-Control: no-store`.
- Пользователи и Telegram имеют отдельные admin-only API и журналы. Мутации бота остаются за пределами первой read-only версии нового операционного центра.

### Инфраструктурные сигналы

- `src/app/api/readiness/route.ts`, `src/lib/readiness.ts` и `src/lib/readiness-probes.ts` уже содержат готовность Web/API, PostgreSQL, схемы, Redis, публикационного и Telegram-воркеров, AI, почты, upload ingress, token keyring и tracking secrets.
- `src/lib/db.ts` и `src/lib/db-pool-monitor.mjs` уже дают max/total/active/idle/waiting, acquire wait p95, acquire timeout/error counters и настроенные таймауты пула.
- `src/lib/schema-readiness.mjs` и `src/lib/schema-manifest.mjs` сверяют применённые миграции, checksum и обязательные capabilities с ожидаемой версией.
- `worker/publication-heartbeat.mjs` и `worker/telegram-polling-heartbeat.mjs` задают строгие форматы, допустимый возраст и обнаружение конфликта Telegram polling.
- `src/lib/ai-provider-health.ts` хранит безопасный in-process circuit snapshot: provider, circuit state, successes/failures, последовательные ошибки, last outcome, latency, safe error code и retryAt.
- `ai_provider_attempts` даёт долговременные provider/model/outcome/latency/token/cost данные, request correlation UUID и safe error code; `ai_usage` содержит подтверждённое использование.
- Sentry уже подключён на client/server через `src/instrumentation-client.ts`, `src/instrumentation.ts` и global error boundary. Сырые события Sentry в PostgreSQL не дублируются.

### Очереди и фоновые процессы

Реально существуют очереди `publish`, `stats`, `media-generation`, `autopilot-plans`, `site-analysis`, `project-export`, `publication-extra`, `monthly-campaign-regeneration`, `legal-visual-render`, `publication-review-reminder` и `cron`. BullMQ позволяет получить waiting/active/delayed/completed/failed, число workers и возраст старейшей ожидающей задачи без чтения payload.

Для подтверждённых результатов и ошибок уже существуют доменные таблицы и журналы:

- публикации: `posts`, `publication_operations`, `publication_outbox`, `publication_operation_events`, `publication_extra_operations`, `publication_extra_attempts`, `publication_extra_outbox`;
- медиа: `media_generations`, `media_assets`, `legal_visual_render_operations`, `legal_visual_render_attempts`, `legal_visual_render_outbox`;
- Автопилот: `autopilot_plan`, `autopilot_approval_operations`, `autopilot_schedule_outbox`, `autopilot_repair_operations`, monthly campaign tables/outbox;
- анализ сайта: `site_analysis_jobs`, страницы, источники, evidence, entities, relations, AI batches, answers и recommendations;
- Радар/конкуренты/инфоповоды: `radar_search_runs`, candidates/results, `competitors`, `competitor_posts`, `competitor_stats`, `rss_items`, legal source/opportunity tables;
- Студия/редактор/знания: `generation_operations`, `generation_results`, `drafts`, revisions/editorial workflow, `studio_chat_sessions`, `knowledge_sources`, `knowledge_chunks`, library states;
- результаты: `post_stats`, `channel_stats`, short-link clicks/unique visitors, conversions и publication tracking snapshots;
- Сегодня/развитие/настройки: `today_item_states`, `today_source_refreshes`, `opportunity_snapshots`, `growth_moves`, account/settings preview tables;
- административные и доменные изменения: `audit_events`, `channel_events`, bot delivery/interaction/admin-action events.

### Каталог пользовательских разделов

`src/lib/app-routes.ts` — существующий источник истины. Для меню пользовательских разделов используются 15 route id из `APP_NAV_GROUPS`: today, calendar, studio, autopilot, composer, library, rss, knowledge, recon, opportunities, radar, siteAnalysis, growth, analytics и settings. Внутренние aliases `competitors` и `trends` не должны создавать дублирующие карточки.

### Начатый контракт событий

В незакоммиченных пользовательских изменениях уже есть `src/lib/product-event-contract.mjs` и тесты. Сейчас это только минимальный validation-only allowlist нескольких старых event names. Storage, ingestion, server-owned tenant identity, общий section/feature/stage contract, retention и агрегаты отсутствуют. Эти файлы нужно расширять совместимо, не откатывая существующую privacy-защиту.

## 2. Каких данных и контрактов не хватает

- Единого результата проверки `{ state, checkedAt, durationMs, evidence, safeErrorCode, lastSuccessAt }` и `Promise.allSettled` для независимых компонентов.
- Снимка всех очередей, Redis INFO (memory, uptime, connections), возраста старейших задач и безопасных переходов из диагностики.
- Долговременного heartbeat publication worker: текущий Redis heartbeat доказывает свежесть, но история successes/failures/average duration берётся только из доменных публикаций.
- Единого runtime release metadata. Deploy использует `AURORA_DEPLOY_SHA`, но runtime-контракт версии и времени развёртывания не оформлен. Нужны безопасные `AURORA_RELEASE`/`AURORA_RELEASE_SHA`/`AURORA_DEPLOYED_AT` с fallback без раскрытия окружения.
- Сквозного request ID middleware. Часть API уже создаёт и сохраняет request UUID, но это не единый контракт всех маршрутов. Новые события должны принимать только валидный correlation id, а сервер генерировать его при отсутствии.
- Строгой section analytics taxonomy, feature catalog, operation-specific SLO и server-owned product event envelope.
- Сырых безопасных событий для page open/start/accepted/queued/processing/completed/failed/retried/cancelled, дедупликации, TTL и долгосрочных агрегатов.
- Реальных frontend page-load/performance measurements. Их нельзя восстановить из доменных таблиц задним числом; до появления событий соответствующие значения должны быть `null`/«нет данных», а не ноль или зелёный статус.
- Унифицированных session/device/new-returning данных. `sessions.device` существует, но нет надёжного last-active/session telemetry; фильтры должны честно показывать доступность и применяться к новым событиям.
- Автоматического импорта Sentry issues. Без отдельного read-only Sentry API credential система может строить безопасную ссылку по заранее настроенному public org/project и коррелировать request ID, но не должна копировать stacktrace или пользовательский контекст.
- Release markers до накопления событий с release. Исторические графики не могут придумывать маркеры прошлых релизов.

## 3. Файлы и таблицы, которые потребуется изменить

### База и контракт схемы

- новая additive migration `db/migrations/20261005_admin_operations_center.sql`;
- bootstrap snapshot `db/schema.sql`;
- `src/lib/schema-manifest.mjs` и migration/checksum tests;
- таблицы `product_events`, `product_event_daily`, `aurora_releases` и индексы tenant/time/dedup/correlation;
- server-only retention/rollup function с ограниченным сроком сырых событий; агрегаты не содержат safeContext или пользовательский контент.

### Server/API

- расширение `src/lib/product-event-contract.mjs` и typings/tests;
- новые `src/lib/product-events.ts`, `src/lib/aurora-section-catalog.ts`, `src/lib/release-metadata.ts`;
- новый authenticated ingestion `src/app/api/product-events/route.ts` с origin check, bounded body, fail-closed rate limit и server-owned user/project;
- новые `src/lib/admin-system-diagnostics.ts`, `src/app/api/admin/system/route.ts`;
- новые `src/lib/admin-aurora-analytics.ts`, `src/app/api/admin/aurora-analytics/route.ts`;
- точечные server-side emitters в подтверждённых domain boundaries; клиентские emitters используются только для открытия/начала и browser timing.

### Admin UI

- `src/components/admin/admin-dashboard.tsx`: новый пункт «Аналитика Авроры», отказ от period switch в «Системе», URL orchestration;
- новые `src/components/admin/admin-system-center.tsx` и `src/components/admin/admin-aurora-analytics.tsx`;
- при необходимости только существующие tokens/classes из `src/app/app/app-v3.css`, без отдельной несовместимой дизайн-системы.

### Тесты и документация

- unit contract/status/PII/error serialization/problem-ranking tests;
- API auth, tenant, rate-limit, no-store и partial-failure tests;
- migration/schema-manifest tests;
- source/DOM contract tests и real E2E расширение для URL, filters, funnel, error details и mobile.

## 4. Итоговая архитектура

1. `aurora-section-catalog` является единственным server/client-safe каталогом 15 разделов, функций, стадий и SLO; labels/href берутся из `APP_ROUTES`.
2. Domain tables остаются источником подтверждённого бизнес-результата. Product events описывают путь пользователя и browser timings, но не подменяют успешный доменный outcome.
3. Ingestion принимает только allowlisted section/feature/action/stage/outcome и bounded scalar `safeContext`. `user_id` и `project_id` всегда добавляет сервер после live membership check.
4. Raw events хранятся ограниченный срок, дедуплируются по tenant + event id, содержат correlation/release и не содержат PII/content. В той же транзакции обновляются долгосрочные счётчики `product_event_daily`.
5. Admin analytics query layer объединяет агрегаты событий с domain confirmations, `ai_provider_attempts`, operation/outbox journals и release rows. Недоступные измерения возвращаются как `null` с coverage, а не как фиктивный ноль.
6. System API запускает независимые bounded probes через `Promise.allSettled`, нормализует шесть состояний, сохраняет evidence/last success in-process без превращения одной ошибки в общий 503 и никогда не сериализует Error/message/URL/env.
7. Admin UI хранит `system`, `analyticsSection`, `analyticsTab` и filters в query string, а верхний раздел — в hash. Навигация использует History API, поэтому refresh/back/forward воспроизводимы.
8. Связи между аналитикой, системой и Sentry используют только section/dependency/safe error code/request ID/release. Первая версия read-only.

## 5. Поэтапный план реализации

1. Зафиксировать каталог разделов/features/stages/SLO и расширить privacy contract.
2. Добавить additive migration, schema manifest, ingestion, rollup/retention и unit/API tests.
3. Добавить безопасный release/request correlation и первые server/domain emitters для Студии, Редактора, Календаря и Автопилота.
4. Реализовать system diagnostics API и partial-failure/auth/no-store tests.
5. Реализовать кликабельный responsive «Система» с URL state и refresh controls.
6. Реализовать analytics query API: overview/funnel/errors/performance/events, filters, comparisons, release markers и ranking.
7. Реализовать «Аналитику Авроры» для четырёх приоритетных разделов, затем подключить остальные источники без demo data.
8. Добавить безопасные Sentry links и cross-navigation.
9. Прогнать migration policy, typecheck, focused tests, full unit/integration/build и real E2E; проверить mobile/a11y/no-demo-data.

## 6. Риски и снижение

- **Кардинальность и объём:** строгие enums, bounded strings, scalar-only context, batching limit, dedupe, raw TTL и агрегаты.
- **PII/секреты:** denylist ключей и значений, server-owned identity, отсутствие произвольного JSON, безопасная сериализация errors, tests с email/token/cookie/content/URL.
- **Ложный зелёный статус:** healthy только после свежего успеха; configuration-only получает `unobserved` или `not_configured`.
- **Диагностика сама создаёт сбой:** короткие timeout, `allSettled`, read-only commands, ограниченная частота admin API и закрытие временных Redis/BullMQ соединений.
- **Tenant leak:** ingestion rechecks selected project membership; admin API остаётся глобальным только после отдельного allowlist; drill-down никогда не возвращает PII/content.
- **Тяжёлые SQL:** time-bounded indexed filters, pre-aggregates, query limits, percentile only over bounded ranges, explain/integration tests.
- **Неполные исторические данные:** coverage/freshness возвращаются явно; никаких backfilled выдуманных событий или релизов.
- **Конфликт с текущими незакоммиченными изменениями:** новые изменения делаются additive и проверяются через `git diff`; пользовательские stabilization-файлы не откатываются.
- **Sentry ownership/compliance:** первая версия хранит только безопасный correlation/link metadata; внешние issue details подключаются лишь при наличии отдельного read-only credential и утверждённой политики.

## 7. Результат реализации

- Добавлены additive schema/migration для releases, raw product events, daily rollups и content-free admin observation audit.
- Реализованы same-origin authenticated ingestion, strict taxonomy/privacy validation, deduplication и bounded retention.
- Раздел «Система» заменён на 15 кликабельных live diagnostics с evidence, очередями, URL/history и refresh controls.
- «Аналитика Авроры» вынесена отдельно и покрывает ровно 15 пользовательских разделов: activity, health, domain outcome, filters, timeline/releases и пять detail tabs.
- Domain outcomes и operational error journals подключены fixed parameterized SQL; unsupported dimensions честно помечаются `not_filterable`.
- Добавлены operation-specific SLO, p50 time-to-result, latest-stage detection и прозрачный problem ranking.
- Cross-navigation связывает safe error → dependency/Sentry, dependency → affected sections, event → request ID.
- Unit/API/source-contract/migration/PostgreSQL transaction/real-E2E сценарии добавлены; эксплуатационные правила описаны в `docs/admin-operations-center-runbook.md`.

## 8. Финальная проверка 2026-08-30

- `npm test`: 538 файлов, 2820 тестов, все прошли.
- `npm run lint`, `npx tsc --noEmit`, `npm run test:focus`, `git diff --check`: прошли без замечаний.
- `npm run test:migrations`: подтверждены 107 additive transactional migrations (на дату аудита); SQL нового analytics query layer также выполнен в транзакции на локальной disposable PostgreSQL.
- Production build: прошёл внутри изолированного real-E2E harness.
- Chromium real E2E: `ok=true`, `browserRuntimeErrors=0`; подтверждены 15 разделов, обе прямые ссылки, history/reload, filters, funnel, error detail, mobile и audit trail.
- Намеренное истечение сессии дало `401`, перенаправило обе вкладки на `/login` и оставило только шесть явно классифицированных ожидаемых наблюдений, без неожиданных browser issues.
- После E2E `aurora_e2e_real` содержит 0 public tables, Redis DB 15 — 0 keys.
