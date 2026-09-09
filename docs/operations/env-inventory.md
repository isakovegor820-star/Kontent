# Статический реестр окружения

Реестр содержит только имена и места статических ссылок. Рабочие `.env*`, значения
переменных, значения GitHub secrets и действующая конфигурация не читались.

Метод: AST TypeScript/JavaScript для прямого доступа `process.env`/`env`, буквальных
ключей, destructuring и объектов передачи env; статические env/secrets ссылки
workflow и shell. Роли определены достижимостью локальных буквальных imports от
entrypoints; общие модули могут появиться в нескольких разделах. Это карта
потребителей, а не утверждение, что каждая переменная обязательна или настроена.
Shell reference может обозначать локальную/передаваемую переменную скрипта;
workflow secret reference — имя входа GitHub, не значение и не автоматический
доступ для runtime. Test-only означает отсутствие найденной runtime-ссылки.

Проверено файлов: 1584. Уникальных статических имён: 289.
Полный source index с типом ссылки: `audit-2026-09-05/evidence/implementation/O07-env-inventory.json`.
Финальная версия определяется commit/build из IMPLEMENTATION-RESULT.md.

## Build

| Имя | Исходные файлы |
| --- | --- |
| `AURORA_BUILD_LOCK_TOKEN` | `scripts/build.mjs:9` |
| `AURORA_BUILD_MAX_OLD_SPACE_SIZE_MB` | `scripts/build.mjs:7` |
| `AURORA_NEXT_DIST_DIR` | `next.config.ts:10` |
| `AURORA_SENTRY_DISABLED` | `next.config.ts:14` |
| `CI` | `next.config.ts:105` |
| `NEXT_PUBLIC_APP_URL` | `src/lib/admin-alerts.ts:208` |
| `NEXT_PUBLIC_AURORA_APP_VERSION` | `.github/workflows/deploy-production.yml:154`<br>`src/components/app/aurora-product-telemetry.tsx:43` |
| `NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES` | `src/proxy.ts:44`<br>`src/lib/app-routes.ts:171`<br>`worker.mjs:439`<br>`src/app/app/settings/page.tsx:94` |
| `NEXT_PUBLIC_AURORA_SENTRY_DISABLED` | `src/instrumentation-client.ts:5` |
| `NEXT_PUBLIC_SENTRY_ENABLE_DEV` | `src/instrumentation-client.ts:16` |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | `src/instrumentation-client.ts:17` |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | `src/instrumentation-client.ts:6` |
| `NEXT_PUBLIC_TREND_REFERENCE_STUDIO` | `src/app/app/trends/page.tsx:969` |
| `NODE_ENV` | `next.config.ts:63` |
| `NODE_OPTIONS` | `scripts/build.mjs:20` |

## Web и общий HTTP bootstrap

| Имя | Исходные файлы |
| --- | --- |
| `AI_API_KEY` | `src/lib/ai-provider.ts:91`<br>`src/lib/transcription-runtime.mjs:10`<br>`src/lib/ai-engine-policy.mjs:55`<br>`src/lib/readiness-probes.ts:79` |
| `AI_API_URL` | `src/lib/ai-provider.ts:92`<br>`src/lib/transcription-runtime.mjs:15`<br>`src/lib/ai-engine-policy.mjs:56` |
| `AI_BALANCED_ATTEMPT_MS` | `src/lib/ai-generation-deadlines.ts:32` |
| `AI_BALANCED_FIRST_TOKEN_MS` | `src/lib/ai-generation-deadlines.ts:31` |
| `AI_BALANCED_PIPELINE_MS` | `src/lib/ai-generation-deadlines.ts:36` |
| `AI_CIRCUIT_FAILURE_THRESHOLD` | `src/lib/ai-completion-service.mjs:328`<br>`src/lib/ai-provider-health.ts:205` |
| `AI_CIRCUIT_MAX_ENTRIES` | `src/lib/ai-provider-health.ts:207` |
| `AI_CIRCUIT_OPEN_MS` | `src/lib/ai-completion-service.mjs:334`<br>`src/lib/ai-provider-health.ts:206` |
| `AI_CLOUD_MODEL` | `src/lib/ai-provider.ts:93`<br>`src/lib/ai-engine-policy.mjs:57` |
| `AI_DAILY_LIMIT` | `src/lib/ai-usage.ts:19` |
| `AI_FALLBACK_ENGINES` | `src/lib/ai-engine-policy.mjs:98` |
| `AI_FALLBACK_STRICT` | `src/lib/ai-engine-policy.mjs:122` |
| `AI_FAST_FIRST_TOKEN_MS` | `src/lib/ai-generation-deadlines.ts:16` |
| `AI_FAST_OVERALL_MS` | `src/lib/ai-generation-deadlines.ts:17` |
| `AI_FAST_PIPELINE_MS` | `src/lib/ai-generation-deadlines.ts:18` |
| `AI_LOCAL_CONTEXT_TOKENS` | `src/lib/ai-provider.ts:637` |
| `AI_MAX_ATTEMPT_MS` | `src/lib/ai-generation-deadlines.ts:24` |
| `AI_MAX_FALLBACK_ATTEMPTS` | `src/lib/ai-completion-service.mjs:313` |
| `AI_MAX_FIRST_TOKEN_MS` | `src/lib/ai-generation-deadlines.ts:23` |
| `AI_MAX_PIPELINE_MS` | `src/lib/ai-generation-deadlines.ts:25` |
| `AI_MODEL` | `src/lib/ai-provider.ts:80`<br>`src/lib/ai-engine-policy.mjs:43` |
| `AI_OPERATION_DEADLINE_MS` | `src/lib/ai-attempt-budget.ts:32` |
| `AI_OPERATION_MAX_ATTEMPTS` | `src/lib/ai-attempt-budget.ts:29`<br>`src/app/api/ai/generate/route.ts:618` |
| `AI_OPERATION_MAX_COST_MICROUSD` | `src/lib/ai-attempt-budget.ts:31` |
| `AI_OPERATION_MAX_TOKENS` | `src/lib/ai-attempt-budget.ts:30` |
| `AI_RESERVATION_TTL_MS` | `src/lib/ai-usage.ts:20` |
| `AI_SEMANTIC_ATTEMPT_TIMEOUT_MS` | `src/lib/ai-semantic-adapter.mjs:110` |
| `AI_SEMANTIC_CIRCUIT_FAILURE_THRESHOLD` | `src/lib/ai-semantic-adapter.mjs:113` |
| `AI_SEMANTIC_CIRCUIT_OPEN_MS` | `src/lib/ai-semantic-adapter.mjs:116` |
| `AI_SEMANTIC_ENGINE` | `src/lib/ai-semantic-adapter.mjs:75` |
| `AI_SEMANTIC_FALLBACK_ENGINES` | `src/lib/ai-semantic-adapter.mjs:81` |
| `AI_SEMANTIC_TIMEOUT_MS` | `src/lib/ai-semantic-adapter.mjs:111` |
| `AI_SERVICE_ENGINE` | `src/lib/ai-engine-policy.mjs:83`<br>`src/lib/readiness-probes.ts:82` |
| `AI_SPEND_GLOBAL_CONCURRENCY` | `src/lib/ai-spend-ledger.mjs:30` |
| `AI_SPEND_GLOBAL_DAILY_MICROUSD` | `src/lib/ai-spend-ledger.mjs:30` |
| `AI_SPEND_PROJECT_CONCURRENCY` | `src/lib/ai-spend-ledger.mjs:30` |
| `AI_SPEND_PROJECT_DAILY_MICROUSD` | `src/lib/ai-spend-ledger.mjs:30` |
| `AI_SPEND_SYSTEM_PROJECT_ID` | `src/lib/ai-spend-ledger.mjs:139` |
| `AI_SPEND_SYSTEM_USER_ID` | `src/lib/ai-spend-ledger.mjs:138` |
| `AI_SPEND_TARIFFS_JSON` | `src/lib/ai-spend-ledger.mjs:33` |
| `AI_SPEND_USER_CONCURRENCY` | `src/lib/ai-spend-ledger.mjs:30` |
| `AI_SPEND_USER_DAILY_MICROUSD` | `src/lib/ai-spend-ledger.mjs:30` |
| `ANTHROPIC_API_KEY` | `src/lib/ai-provider.ts:97`<br>`src/lib/ai-engine-policy.mjs:91`<br>`src/lib/readiness-probes.ts:80` |
| `ANTHROPIC_API_URL` | `src/lib/ai-provider.ts:98`<br>`src/lib/ai-engine-policy.mjs:60` |
| `ANTHROPIC_MODEL` | `src/lib/ai-provider.ts:99`<br>`src/lib/ai-engine-policy.mjs:61` |
| `APP_URL` | `src/lib/admin-alerts.ts:208`<br>`src/lib/admin-bot.ts:172`<br>`src/lib/password-reset.ts:35`<br>`src/lib/request-origin.ts:42`<br>`src/lib/oauth-request.ts:7`<br>`src/lib/readiness-probes.ts:147`<br>`src/lib/admin-system-diagnostics.ts:829`<br>`src/lib/site-destinations/hosted.mjs:11` |
| `AURORA_ADMIN_ALERTS` | `src/lib/admin-alerts.ts:55` |
| `AURORA_ADMIN_ALERTS_INTERVAL_MS` | `src/lib/admin-alerts.ts:56` |
| `AURORA_ADMIN_ALERTS_OVERDUE_THRESHOLD` | `src/lib/admin-alerts.ts:58` |
| `AURORA_ADMIN_ALERTS_REPEAT_MS` | `src/lib/admin-alerts.ts:57` |
| `AURORA_ADMIN_EMAILS` | `src/lib/admin-alerts.ts:149`<br>`src/lib/admin-access.ts:23` |
| `AURORA_ADMIN_USER_IDS` | `src/lib/admin-alerts.ts:148`<br>`src/lib/admin-access.ts:22` |
| `AURORA_AVATAR_BODY_LIMIT_BYTES` | `src/lib/upload-ingress.mjs:6` |
| `AURORA_DB_CONNECTION_TIMEOUT_MS` | `src/lib/db-pool-config.mjs:44` |
| `AURORA_DB_IDLE_TIMEOUT_MS` | `src/lib/db-pool-config.mjs:68` |
| `AURORA_DB_IDLE_TRANSACTION_TIMEOUT_MS` | `src/lib/db-pool-config.mjs:62` |
| `AURORA_DB_MAX_LIFETIME_SECONDS` | `src/lib/db-pool-config.mjs:74` |
| `AURORA_DB_POOL_MAX` | `src/lib/db-pool-config.mjs:34` |
| `AURORA_DB_POOL_MAX_WEB` | `src/lib/db-pool-config.mjs:31` |
| `AURORA_DB_POOL_MAX_WORKER` | `src/lib/db-pool-config.mjs:33` |
| `AURORA_DB_QUERY_TIMEOUT_MS` | `src/lib/db-pool-config.mjs:50` |
| `AURORA_DB_STATEMENT_TIMEOUT_MS` | `src/lib/db-pool-config.mjs:56` |
| `AURORA_DEPLOY_SHA` | `src/lib/release-metadata.mjs:29` |
| `AURORA_DEPLOYED_AT` | `src/lib/release-metadata.mjs:34` |
| `AURORA_DEV_STARTUP_TIMEOUT_MS` | `scripts/dev-bootstrap.mjs:47` |
| `AURORA_OUTBOUND_DISABLED` | `src/lib/admin-alerts.ts:196` |
| `AURORA_PDF_FONT_PATH` | `src/lib/library-export.mjs:49` |
| `AURORA_PRODUCT_EVENT_RETENTION_DAYS` | `src/lib/product-events.ts:14` |
| `AURORA_READINESS_TOKEN` | `src/app/api/readiness/route.ts:32` |
| `AURORA_RELEASE` | `src/lib/release-metadata.mjs:32` |
| `AURORA_RELEASE_SHA` | `src/lib/release-metadata.mjs:29` |
| `AURORA_RELEASE1_DEV_ENABLED` | `src/lib/today-refresh.ts:79`<br>`src/lib/content-intelligence.ts:101`<br>`src/lib/today.ts:185` |
| `AURORA_RUNTIME_ROLE` | `src/lib/admin-alerts-scheduler.ts:42`<br>`src/lib/db-pool-config.mjs:29`<br>`scripts/start.mjs:52` |
| `AURORA_SENTRY_DISABLED` | `sentry.server.config.ts:5`<br>`sentry.edge.config.ts:5` |
| `AURORA_SITES_DOMAIN` | `src/lib/site-destinations/hosted.mjs:8` |
| `AURORA_TRACKER_ALLOW_LOCAL_VERIFICATION` | `src/lib/tracking-service.ts:239` |
| `AURORA_TRACKER_LOCAL_VERIFICATION_ORIGINS` | `src/lib/tracking-service.ts:243` |
| `AURORA_TRUST_X_REAL_IP` | `src/lib/rate-limit.ts:143` |
| `AURORA_TRUSTED_PROXY_HOPS` | `src/lib/rate-limit.ts:135` |
| `AUTOPILOT_AI_ATTEMPT_TIMEOUT_MS` | `src/lib/autopilot-config.mjs:65` |
| `AUTOPILOT_AI_OVERALL_TIMEOUT_MS` | `src/lib/autopilot-config.mjs:66` |
| `DATABASE_URL` | `src/lib/db.ts:56`<br>`src/lib/readiness-probes.ts:40`<br>`src/lib/admin-system-diagnostics.ts:513`<br>`scripts/migrate.mjs:241`<br>`scripts/dev-bootstrap.mjs:235`<br>`scripts/runtime-schema-preflight.mjs:36`<br>`src/app/api/auth/login/route.ts:44`<br>`src/app/api/auth/password/forgot/route.ts:73`<br>`src/app/api/auth/register/route.ts:56`<br>`src/app/api/auth/password/reset/route.ts:45`<br>`src/app/api/lead/route.ts:59` |
| `EMAIL_API_KEY` | `src/lib/password-reset-delivery.mjs:3`<br>`src/lib/readiness-probes.ts:145`<br>`src/lib/email-change-delivery.mjs:3`<br>`src/app/api/auth/password/forgot/route.ts:69` |
| `EMAIL_CHANGE_FROM` | `src/lib/email-change-delivery.mjs:4` |
| `EMAIL_FROM` | `src/lib/password-reset-delivery.mjs:4`<br>`src/lib/readiness-probes.ts:146`<br>`src/lib/email-change-delivery.mjs:4`<br>`src/app/api/auth/password/forgot/route.ts:70` |
| `GEMINI_API_KEY` | `src/lib/ai-provider.ts:103`<br>`src/lib/ai-engine-policy.mjs:92`<br>`src/lib/readiness-probes.ts:81` |
| `GEMINI_API_URL` | `src/lib/ai-provider.ts:104`<br>`src/lib/ai-engine-policy.mjs:64` |
| `GEMINI_MODEL` | `src/lib/ai-provider.ts:105`<br>`src/lib/ai-engine-policy.mjs:65` |
| `GITHUB_SHA` | `src/lib/release-metadata.mjs:29` |
| `GOOGLE_CLIENT_ID` | `src/lib/social-providers.mjs:30` |
| `GOOGLE_CLIENT_SECRET` | `src/lib/social-providers.mjs:31` |
| `LEGAL_PROVIDER_CONFIG_JSON` | `src/lib/legal-provider-adapter.mjs:125` |
| `MEDIA_GENERATION_ENABLED` | `src/app/api/media/generations/route.ts:205`<br>`src/app/api/media/capabilities/route.ts:11` |
| `MEDIA_IMAGE_DAILY_LIMIT` | `src/app/api/media/generations/route.ts:281` |
| `MEDIA_OBJECT_BUCKET` | `src/lib/media-storage.mjs:16` |
| `MEDIA_OBJECT_ENDPOINT` | `src/lib/media-storage.mjs:22` |
| `MEDIA_OBJECT_FORCE_PATH_STYLE` | `src/lib/media-storage.mjs:23` |
| `MEDIA_OBJECT_REGION` | `src/lib/media-storage.mjs:17` |
| `MEDIA_OBJECT_VIDEO_THRESHOLD_BYTES` | `src/lib/media-storage.mjs:42` |
| `MEDIA_VIDEO_DAILY_LIMIT` | `src/app/api/media/generations/route.ts:280` |
| `META_APP_ID` | `src/lib/social-providers.mjs:49` |
| `META_APP_SECRET` | `src/lib/social-providers.mjs:50` |
| `META_GRAPH_API_BASE` | `src/lib/social-providers.mjs:19`<br>`src/lib/instagram.mjs:23` |
| `META_GRAPH_API_VERSION` | `src/lib/social-providers.mjs:18`<br>`src/lib/instagram.mjs:22` |
| `NAVYAI_API_KEY` | `src/lib/ai-provider.ts:108`<br>`src/lib/transcription-runtime.mjs:20`<br>`src/lib/ai-engine-policy.mjs:89`<br>`src/lib/readiness-probes.ts:78`<br>`src/app/api/media/generations/route.ts:208`<br>`src/app/api/media/capabilities/route.ts:16` |
| `NAVYAI_API_URL` | `src/lib/ai-provider.ts:109`<br>`src/lib/transcription-runtime.mjs:25`<br>`src/lib/ai-engine-policy.mjs:53`<br>`src/app/api/media/generations/route.ts:258`<br>`src/app/api/media/capabilities/route.ts:17` |
| `NAVYAI_TRANSCRIPTION_MODEL` | `src/lib/transcription-runtime.mjs:26` |
| `NEXT_PHASE` | `src/lib/admin-alerts-scheduler.ts:41` |
| `NEXT_PUBLIC_APP_URL` | `src/lib/admin-alerts.ts:208` |
| `NEXT_PUBLIC_AURORA_APP_VERSION` | `src/components/app/aurora-product-telemetry.tsx:43` |
| `NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES` | `src/proxy.ts:44`<br>`src/lib/app-routes.ts:171`<br>`src/app/app/settings/page.tsx:94` |
| `NEXT_PUBLIC_AURORA_SENTRY_DISABLED` | `src/instrumentation-client.ts:5` |
| `NEXT_PUBLIC_SENTRY_ENABLE_DEV` | `src/instrumentation-client.ts:16` |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | `src/instrumentation-client.ts:17` |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | `src/instrumentation-client.ts:6` |
| `NEXT_PUBLIC_TREND_REFERENCE_STUDIO` | `src/app/app/trends/page.tsx:969` |
| `NEXT_RUNTIME` | `src/instrumentation.ts:4` |
| `NODE_ENV` | `sentry.server.config.ts:4`<br>`src/proxy.ts:32`<br>`src/instrumentation-client.ts:4`<br>`src/lib/upload-ingress.mjs:9`<br>`src/lib/today-refresh.ts:79`<br>`src/lib/tracking-service.ts:135`<br>`src/lib/password-reset.ts:39`<br>`src/lib/content-intelligence.ts:101`<br>`src/lib/request-origin.ts:38`<br>`src/lib/admin-alerts-scheduler.ts:41`<br>`src/lib/oauth-request.ts:12`<br>`src/lib/readiness-probes.ts:153`<br>`src/lib/today.ts:185`<br>`src/lib/db-pool-config.mjs:36`<br>`sentry.edge.config.ts:4`<br>`src/lib/session.ts:46`<br>`src/lib/admin-system-diagnostics.ts:834`<br>`src/lib/phone-verification-mode.mjs:2`<br>`scripts/start.mjs:60`<br>`src/app/bot/workspace.tsx:50`<br>`src/app/api/channels/oauth/start/route.ts:30` |
| `OLLAMA_KEEP_ALIVE` | `src/lib/ai-provider.ts:645` |
| `OLLAMA_URL` | `src/lib/ai-provider.ts:79`<br>`src/lib/ai-engine-policy.mjs:42` |
| `OPENAI_API_KEY` | `src/lib/ai-provider.ts:91`<br>`src/lib/transcription-runtime.mjs:10`<br>`src/lib/ai-engine-policy.mjs:55`<br>`src/lib/readiness-probes.ts:79` |
| `OPENAI_API_URL` | `src/lib/ai-provider.ts:92`<br>`src/lib/transcription-runtime.mjs:15`<br>`src/lib/ai-engine-policy.mjs:56` |
| `OPENAI_MODEL` | `src/lib/ai-provider.ts:93`<br>`src/lib/ai-engine-policy.mjs:57` |
| `OPENAI_TRANSCRIPTION_MODEL` | `src/lib/transcription-runtime.mjs:16` |
| `PASSWORD_RESET_FROM` | `src/lib/password-reset-delivery.mjs:4`<br>`src/lib/readiness-probes.ts:146`<br>`src/app/api/auth/password/forgot/route.ts:70` |
| `PGSSL_REJECT_UNAUTHORIZED` | `src/lib/db.ts:65`<br>`scripts/migrate.mjs:126`<br>`scripts/dev-bootstrap.mjs:79`<br>`scripts/runtime-schema-preflight.mjs:17` |
| `REDIS_URL` | `src/lib/queue.ts:23`<br>`src/lib/legal-visual-render-queue.mjs:7`<br>`src/lib/rate-limit.ts:25`<br>`src/lib/readiness-probes.ts:181`<br>`src/lib/project-export-queue.mjs:7`<br>`src/lib/admin-system-diagnostics.ts:252`<br>`scripts/dev-bootstrap.mjs:236` |
| `RESEND_API_KEY` | `src/lib/password-reset-delivery.mjs:3`<br>`src/lib/readiness-probes.ts:145`<br>`src/lib/email-change-delivery.mjs:3`<br>`src/app/api/auth/password/forgot/route.ts:69` |
| `SENTRY_ENABLE_DEV` | `sentry.server.config.ts:16`<br>`sentry.edge.config.ts:16` |
| `SENTRY_ENVIRONMENT` | `sentry.server.config.ts:17`<br>`sentry.edge.config.ts:17` |
| `SENTRY_ORG_SLUG` | `src/lib/admin-aurora-analytics.ts:1059` |
| `SENTRY_PROJECT_ID` | `src/lib/admin-aurora-analytics.ts:1060` |
| `SENTRY_TRACES_SAMPLE_RATE` | `sentry.server.config.ts:6`<br>`sentry.edge.config.ts:6` |
| `TENCHAT_OFFICIAL_ACCESS_GRANT_ID` | `src/lib/tenchat-integration.mjs:17` |
| `TENCHAT_OFFICIAL_ACCESS_MODE` | `src/lib/tenchat-integration.mjs:16` |
| `TENCHAT_OFFICIAL_API_BASE_URL` | `src/lib/tenchat-integration.mjs:18` |
| `TENCHAT_OFFICIAL_API_TOKEN` | `src/lib/tenchat-integration.mjs:19` |
| `TG_API_URL` | `src/lib/admin-bot.ts:173`<br>`src/app/api/bot/connect/route.ts:41` |
| `TG_BOT_TOKEN` | `src/lib/admin-alerts.ts:192`<br>`src/lib/admin-bot.ts:171`<br>`src/lib/readiness-probes.ts:182`<br>`src/lib/audience-assistant.ts:448`<br>`src/lib/notify.ts:12`<br>`src/lib/admin-system-diagnostics.ts:628`<br>`src/app/api/channels/connect/route.ts:74`<br>`src/app/api/auth/telegram/route.ts:32`<br>`src/app/api/bot/connect/route.ts:38`<br>`src/app/api/bot/miniapp/overview/route.ts:11` |
| `TG_BOT_USERNAME` | `src/app/api/bot/connect/route.ts:23`<br>`src/app/api/bot/link/route.ts:26` |
| `TG_CHAT_ID` | `src/lib/notify.ts:13` |
| `TOKENS_KEY_ID` | `src/lib/token-crypto.mjs:38` |
| `TOKENS_MASTER_KEY` | `src/lib/token-crypto.mjs:37`<br>`src/lib/readiness-probes.ts:148`<br>`src/app/api/settings/profile/email/request/route.ts:100`<br>`src/app/api/channels/connect-vk/route.ts:62`<br>`src/app/api/channels/oauth/callback/route.ts:98`<br>`src/app/api/channels/oauth/start/route.ts:72`<br>`src/app/api/auth/password/forgot/route.ts:71` |
| `TOKENS_OLD_KEYS` | `src/lib/token-crypto.mjs:42` |
| `TRACKING_ATTRIBUTION_SECRET` | `src/lib/readiness-probes.ts:169`<br>`src/lib/tracking-secrets.ts:6` |
| `TRACKING_FINGERPRINT_SECRET` | `src/lib/readiness-probes.ts:170`<br>`src/lib/tracking-secrets.ts:6` |
| `VERCEL_GIT_COMMIT_SHA` | `src/lib/release-metadata.mjs:29` |
| `VITEST` | `src/lib/admin-alerts-scheduler.ts:41` |
| `VK_APP_ID` | `src/app/api/auth/vk/route.ts:34` |
| `VK_APP_SECRET` | `src/app/api/auth/vk/route.ts:35` |

## Worker и общий runtime bootstrap

| Имя | Исходные файлы |
| --- | --- |
| `AI_API_KEY` | `src/lib/transcription-runtime.mjs:10`<br>`src/lib/ai-engine-policy.mjs:55`<br>`worker/embeddings.mjs:13` |
| `AI_API_URL` | `src/lib/transcription-runtime.mjs:15`<br>`src/lib/ai-engine-policy.mjs:56`<br>`worker/embeddings.mjs:14` |
| `AI_CIRCUIT_FAILURE_THRESHOLD` | `src/lib/ai-completion-service.mjs:328` |
| `AI_CIRCUIT_OPEN_MS` | `src/lib/ai-completion-service.mjs:334` |
| `AI_CLOUD_MODEL` | `src/lib/ai-engine-policy.mjs:57` |
| `AI_DAILY_LIMIT` | `worker/ai-usage-reservation.mjs:4` |
| `AI_FALLBACK_ENGINES` | `src/lib/ai-engine-policy.mjs:98` |
| `AI_FALLBACK_STRICT` | `src/lib/ai-engine-policy.mjs:122` |
| `AI_MAX_FALLBACK_ATTEMPTS` | `src/lib/ai-completion-service.mjs:313` |
| `AI_MODEL` | `src/lib/ai-engine-policy.mjs:43` |
| `AI_SEMANTIC_ATTEMPT_TIMEOUT_MS` | `src/lib/ai-semantic-adapter.mjs:110` |
| `AI_SEMANTIC_CIRCUIT_FAILURE_THRESHOLD` | `src/lib/ai-semantic-adapter.mjs:113` |
| `AI_SEMANTIC_CIRCUIT_OPEN_MS` | `src/lib/ai-semantic-adapter.mjs:116` |
| `AI_SEMANTIC_ENGINE` | `worker/site-analysis-worker.mjs:140`<br>`src/lib/ai-semantic-adapter.mjs:75` |
| `AI_SEMANTIC_FALLBACK_ENGINES` | `src/lib/ai-semantic-adapter.mjs:81` |
| `AI_SEMANTIC_TIMEOUT_MS` | `worker.mjs:462`<br>`src/lib/ai-semantic-adapter.mjs:111` |
| `AI_SERVICE_ENGINE` | `src/lib/ai-engine-policy.mjs:83` |
| `AI_SPEND_GLOBAL_CONCURRENCY` | `src/lib/ai-spend-ledger.mjs:30` |
| `AI_SPEND_GLOBAL_DAILY_MICROUSD` | `src/lib/ai-spend-ledger.mjs:30` |
| `AI_SPEND_PROJECT_CONCURRENCY` | `src/lib/ai-spend-ledger.mjs:30` |
| `AI_SPEND_PROJECT_DAILY_MICROUSD` | `src/lib/ai-spend-ledger.mjs:30` |
| `AI_SPEND_SYSTEM_PROJECT_ID` | `src/lib/ai-spend-ledger.mjs:139` |
| `AI_SPEND_SYSTEM_USER_ID` | `src/lib/ai-spend-ledger.mjs:138` |
| `AI_SPEND_TARIFFS_JSON` | `src/lib/ai-spend-ledger.mjs:33` |
| `AI_SPEND_USER_CONCURRENCY` | `src/lib/ai-spend-ledger.mjs:30` |
| `AI_SPEND_USER_DAILY_MICROUSD` | `src/lib/ai-spend-ledger.mjs:30` |
| `AI_WORKER_RESERVATION_TTL_MS` | `worker/ai-usage-reservation.mjs:9` |
| `ANTHROPIC_API_KEY` | `src/lib/ai-engine-policy.mjs:91` |
| `ANTHROPIC_API_URL` | `src/lib/ai-engine-policy.mjs:60` |
| `ANTHROPIC_MODEL` | `src/lib/ai-engine-policy.mjs:61` |
| `APP_URL` | `worker/email-change-outbox.mjs:67`<br>`worker/password-reset-outbox.mjs:66`<br>`worker.mjs:2893`<br>`src/lib/site-destinations/hosted.mjs:11` |
| `AURORA_AVATAR_BODY_LIMIT_BYTES` | `src/lib/upload-ingress.mjs:6` |
| `AURORA_DB_CONNECTION_TIMEOUT_MS` | `src/lib/db-pool-config.mjs:44` |
| `AURORA_DB_IDLE_TIMEOUT_MS` | `src/lib/db-pool-config.mjs:68` |
| `AURORA_DB_IDLE_TRANSACTION_TIMEOUT_MS` | `src/lib/db-pool-config.mjs:62` |
| `AURORA_DB_MAX_LIFETIME_SECONDS` | `src/lib/db-pool-config.mjs:74` |
| `AURORA_DB_POOL_MAX` | `src/lib/db-pool-config.mjs:34` |
| `AURORA_DB_POOL_MAX_WEB` | `src/lib/db-pool-config.mjs:31` |
| `AURORA_DB_POOL_MAX_WORKER` | `src/lib/db-pool-config.mjs:33` |
| `AURORA_DB_QUERY_TIMEOUT_MS` | `src/lib/db-pool-config.mjs:50` |
| `AURORA_DB_STATEMENT_TIMEOUT_MS` | `src/lib/db-pool-config.mjs:56` |
| `AURORA_DEPLOY_SHA` | `src/lib/release-metadata.mjs:29` |
| `AURORA_DEPLOYED_AT` | `src/lib/release-metadata.mjs:34` |
| `AURORA_DEV_STARTUP_TIMEOUT_MS` | `scripts/dev-bootstrap.mjs:47` |
| `AURORA_OUTBOUND_DISABLED` | `worker/outbound-guard.mjs:3` |
| `AURORA_PDF_FONT_PATH` | `src/lib/library-export.mjs:49` |
| `AURORA_RELEASE` | `src/lib/release-metadata.mjs:32` |
| `AURORA_RELEASE_SHA` | `src/lib/release-metadata.mjs:29` |
| `AURORA_RUNTIME_ROLE` | `src/lib/db-pool-config.mjs:29`<br>`worker.mjs:20`<br>`scripts/start.mjs:52` |
| `AURORA_SENTRY_DISABLED` | `sentry.worker.config.mjs:5` |
| `AURORA_SITES_DOMAIN` | `src/lib/site-destinations/hosted.mjs:8` |
| `AURORA_WORKER_MODE` | `worker.mjs:443` |
| `AUTOPILOT_AI_ATTEMPT_TIMEOUT_MS` | `src/lib/autopilot-config.mjs:65` |
| `AUTOPILOT_AI_CIRCUIT_OPEN_MS` | `worker.mjs:452` |
| `AUTOPILOT_AI_OVERALL_TIMEOUT_MS` | `src/lib/autopilot-config.mjs:66` |
| `AUTOPILOT_SEMANTIC_ENGINE` | `worker.mjs:459` |
| `AUTOPILOT_SEMANTIC_TIMEOUT_MS` | `worker.mjs:456` |
| `DATABASE_URL` | `worker.mjs:436`<br>`scripts/migrate.mjs:241`<br>`scripts/dev-bootstrap.mjs:235`<br>`scripts/runtime-schema-preflight.mjs:36`<br>`scripts/site-analysis-worker.mjs:9` |
| `EMAIL_API_KEY` | `src/lib/password-reset-delivery.mjs:3`<br>`src/lib/email-change-delivery.mjs:3` |
| `EMAIL_CHANGE_FROM` | `src/lib/email-change-delivery.mjs:4` |
| `EMAIL_FROM` | `src/lib/password-reset-delivery.mjs:4`<br>`src/lib/email-change-delivery.mjs:4` |
| `EMBED_CLOUD_MODEL` | `worker/embeddings.mjs:16` |
| `EMBED_MODEL` | `worker/embeddings.mjs:15` |
| `GEMINI_API_KEY` | `src/lib/ai-engine-policy.mjs:92` |
| `GEMINI_API_URL` | `src/lib/ai-engine-policy.mjs:64` |
| `GEMINI_MODEL` | `src/lib/ai-engine-policy.mjs:65` |
| `GITHUB_SHA` | `src/lib/release-metadata.mjs:29` |
| `GOOGLE_CLIENT_ID` | `src/lib/social-providers.mjs:30` |
| `GOOGLE_CLIENT_SECRET` | `src/lib/social-providers.mjs:31` |
| `MEDIA_IMAGE_MAX_BYTES` | `worker.mjs:862` |
| `MEDIA_OBJECT_BUCKET` | `src/lib/media-storage.mjs:16` |
| `MEDIA_OBJECT_ENDPOINT` | `src/lib/media-storage.mjs:22` |
| `MEDIA_OBJECT_FORCE_PATH_STYLE` | `src/lib/media-storage.mjs:23` |
| `MEDIA_OBJECT_REGION` | `src/lib/media-storage.mjs:17` |
| `MEDIA_OBJECT_VIDEO_THRESHOLD_BYTES` | `src/lib/media-storage.mjs:42` |
| `MEDIA_VIDEO_MAX_BYTES` | `worker.mjs:863` |
| `META_APP_ID` | `src/lib/social-providers.mjs:49` |
| `META_APP_SECRET` | `src/lib/social-providers.mjs:50` |
| `META_GRAPH_API_BASE` | `src/lib/social-providers.mjs:19`<br>`src/lib/instagram-business-discovery.mjs:53`<br>`src/lib/instagram.mjs:23` |
| `META_GRAPH_API_VERSION` | `src/lib/social-providers.mjs:18`<br>`src/lib/instagram.mjs:22` |
| `NAVYAI_API_KEY` | `src/lib/transcription-runtime.mjs:20`<br>`src/lib/ai-engine-policy.mjs:89`<br>`worker.mjs:860` |
| `NAVYAI_API_URL` | `src/lib/transcription-runtime.mjs:25`<br>`src/lib/ai-engine-policy.mjs:53`<br>`worker.mjs:861` |
| `NAVYAI_TRANSCRIPTION_MODEL` | `src/lib/transcription-runtime.mjs:26` |
| `NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES` | `worker.mjs:439` |
| `NODE_ENV` | `src/lib/upload-ingress.mjs:9`<br>`sentry.worker.config.mjs:4`<br>`src/lib/db-pool-config.mjs:36`<br>`worker.mjs:2898`<br>`scripts/start.mjs:60` |
| `OLLAMA_URL` | `src/lib/ai-engine-policy.mjs:42`<br>`worker/embeddings.mjs:12` |
| `OPENAI_API_KEY` | `src/lib/transcription-runtime.mjs:10`<br>`src/lib/ai-engine-policy.mjs:55` |
| `OPENAI_API_URL` | `src/lib/transcription-runtime.mjs:15`<br>`src/lib/ai-engine-policy.mjs:56` |
| `OPENAI_MODEL` | `src/lib/ai-engine-policy.mjs:57` |
| `OPENAI_TRANSCRIPTION_MODEL` | `src/lib/transcription-runtime.mjs:16` |
| `PASSWORD_RESET_FROM` | `src/lib/password-reset-delivery.mjs:4` |
| `PGSSL_REJECT_UNAUTHORIZED` | `worker.mjs:712`<br>`scripts/migrate.mjs:126`<br>`scripts/dev-bootstrap.mjs:79`<br>`scripts/runtime-schema-preflight.mjs:17`<br>`scripts/site-analysis-worker.mjs:21` |
| `PUBLICATION_OVERDUE_GRACE_MS` | `worker/publication-safety.mjs:12` |
| `RADAR_SEARXNG_URL` | `worker.mjs:4636` |
| `REDIS_URL` | `src/lib/legal-visual-render-queue.mjs:7`<br>`src/lib/publication-extra-queue.mjs:7`<br>`src/lib/project-export-queue.mjs:7`<br>`worker.mjs:435`<br>`scripts/dev-bootstrap.mjs:236`<br>`scripts/site-analysis-worker.mjs:8` |
| `RESEND_API_KEY` | `src/lib/password-reset-delivery.mjs:3`<br>`src/lib/email-change-delivery.mjs:3` |
| `RETRY_DELAYS_MS` | `worker.mjs:1366` |
| `SENTRY_ENABLE_DEV` | `sentry.worker.config.mjs:16` |
| `SENTRY_ENVIRONMENT` | `sentry.worker.config.mjs:17` |
| `SENTRY_TRACES_SAMPLE_RATE` | `sentry.worker.config.mjs:6` |
| `SITE_ANALYSIS_ENGINE` | `worker/site-analysis-worker.mjs:140` |
| `SITE_ARTICLES_ENGINE` | `worker/site-articles-worker.mjs:309` |
| `SITE_CLASSIFIER_ENGINE` | `worker/site-ai-worker.mjs:97` |
| `SITE_INTERPRETATION_ENGINE` | `worker/site-ai-worker.mjs:221` |
| `SITE_PROBE_ENGINES` | `worker/site-visibility-probe.mjs:24` |
| `TENCHAT_OFFICIAL_ACCESS_GRANT_ID` | `src/lib/tenchat-integration.mjs:17` |
| `TENCHAT_OFFICIAL_ACCESS_MODE` | `src/lib/tenchat-integration.mjs:16` |
| `TENCHAT_OFFICIAL_API_BASE_URL` | `src/lib/tenchat-integration.mjs:18` |
| `TENCHAT_OFFICIAL_API_TOKEN` | `src/lib/tenchat-integration.mjs:19` |
| `TG_API_URL` | `worker.mjs:479` |
| `TG_BOT_TOKEN` | `worker.mjs:437` |
| `TG_BOT_USERNAME` | `worker.mjs:2911` |
| `TG_CHAT_ID` | `worker.mjs:438` |
| `TG_WEBHOOK_URL` | `worker.mjs:2674` |
| `TOKENS_KEY_ID` | `src/lib/token-crypto.mjs:38` |
| `TOKENS_MASTER_KEY` | `src/lib/token-crypto.mjs:37` |
| `TOKENS_OLD_KEYS` | `src/lib/token-crypto.mjs:42` |
| `VERCEL_GIT_COMMIT_SHA` | `src/lib/release-metadata.mjs:29` |

## Deploy / operator scripts

| Имя | Исходные файлы |
| --- | --- |
| `AI_API_KEY` | `.github/workflows/deploy-production.yml:123` |
| `AI_DAILY_LIMIT` | `.github/workflows/deploy-production.yml:124` |
| `AURORA_AI_FALLBACK_ENGINES` | `scripts/deploy-production.sh:24`<br>`.github/workflows/deploy-production.yml:248` |
| `AURORA_AI_SEMANTIC_ENGINE` | `scripts/deploy-production.sh:25`<br>`.github/workflows/deploy-production.yml:248` |
| `AURORA_AI_SEMANTIC_FALLBACK_ENGINES` | `scripts/deploy-production.sh:26`<br>`.github/workflows/deploy-production.yml:248` |
| `AURORA_AI_SERVICE_ENGINE` | `scripts/deploy-production.sh:23`<br>`.github/workflows/deploy-production.yml:248` |
| `AURORA_ALLOW_LOCAL_PEER_MIGRATIONS` | `scripts/deploy-production.sh:372`<br>`scripts/run-production-migrations.sh:23`<br>`.github/workflows/deploy-production.yml:248` |
| `AURORA_ALLOW_TELEGRAM_SANDBOX_SEND` | `scripts/telegram-sandbox-smoke.mjs:21`<br>`.github/workflows/telegram-sandbox-smoke.yml:19` |
| `AURORA_AVATAR_BODY_LIMIT_BYTES` | `scripts/deploy-production.sh:20`<br>`.github/workflows/deploy-production.yml:248`<br>`.github/workflows/production-avatar-ingress.yml:62` |
| `AURORA_BUILD_ARCHIVE` | `scripts/deploy-production.sh:16` |
| `AURORA_BUILD_ARCHIVE_SHA256` | `scripts/deploy-production.sh:17` |
| `AURORA_CURRENT_LINK` | `scripts/deploy-production.sh:13`<br>`scripts/production-autopilot-diagnostics.sh:12` |
| `AURORA_DB_POOL_MAX_WEB` | `scripts/deploy-production.sh:21`<br>`.github/workflows/deploy-production.yml:248` |
| `AURORA_DB_POOL_MAX_WORKER` | `scripts/deploy-production.sh:22`<br>`.github/workflows/deploy-production.yml:248` |
| `AURORA_DEPLOY_ACTION` | `scripts/deploy-production.sh:11` |
| `AURORA_DEPLOY_SHA` | `scripts/deploy-production.sh:10`<br>`.github/workflows/deploy-production.yml:54` |
| `AURORA_DEPLOYMENT_SMOKE_ALLOW_FORWARD_SCHEMA` | `scripts/deployment-smoke.mjs:93`<br>`.github/workflows/deploy-production.yml:62` |
| `AURORA_DEPLOYMENT_SMOKE_BASE_URL` | `scripts/deployment-smoke.mjs:67`<br>`.github/workflows/production-ai-readiness-recovery.yml:110`<br>`.github/workflows/deployment-smoke.yml:19`<br>`.github/workflows/deploy-production.yml:60` |
| `AURORA_DEPLOYMENT_SMOKE_PROFILE` | `scripts/deployment-smoke.mjs:84`<br>`.github/workflows/production-ai-readiness-recovery.yml:96`<br>`.github/workflows/deployment-smoke.yml:20`<br>`.github/workflows/deploy-production.yml:61` |
| `AURORA_DIAG_PROBE_PROVIDER` | `scripts/production-autopilot-diagnostics.sh:292` |
| `AURORA_DIAG_READINESS` | `scripts/production-autopilot-diagnostics.sh:275` |
| `AURORA_DIAG_SQL_B64` | `scripts/production-autopilot-diagnostics.sh:388` |
| `AURORA_ENGINE_CHANNELS` | `scripts/production-autopilot-engine-switch.sh:17`<br>`.github/workflows/production-autopilot-engine-switch.yml:107` |
| `AURORA_ENGINE_ID` | `scripts/production-autopilot-engine-switch.sh:18`<br>`.github/workflows/production-autopilot-engine-switch.yml:107` |
| `AURORA_FORCE_BUILD` | `scripts/production-autopilot-engine-switch.sh:20` |
| `AURORA_FORCE_BUILD_CHANNELS` | `scripts/production-autopilot-engine-switch.sh:109` |
| `AURORA_HEALTH_ATTEMPTS` | `scripts/deploy-production.sh:28` |
| `AURORA_HEALTH_SLEEP_SECS` | `scripts/deploy-production.sh:29` |
| `AURORA_HEALTH_URL` | `scripts/deploy-production.sh:27` |
| `AURORA_INCOMPLETE_RELEASE_SHA` | `scripts/deploy-production.sh:15`<br>`.github/workflows/deploy-production.yml:248` |
| `AURORA_KEEP_RELEASES` | `scripts/deploy-production.sh:14` |
| `AURORA_MIGRATION_DATABASE_URL` | `scripts/run-production-migrations.sh:13` |
| `AURORA_OUTBOUND_DISABLED` | `scripts/prepare-restored-publications.mjs:56` |
| `AURORA_READINESS_TOKEN` | `scripts/deployment-smoke.mjs:88`<br>`scripts/production-autopilot-diagnostics.sh:263`<br>`.github/workflows/production-ai-readiness-recovery.yml:109`<br>`.github/workflows/deployment-smoke.yml:21`<br>`.github/workflows/deploy-production.yml:63` |
| `AURORA_RELEASES_DIR` | `scripts/deploy-production.sh:12` |
| `AURORA_REQUIRED_CI_CHECKS` | `scripts/verify-required-ci-checks.mjs:34`<br>`.github/workflows/deploy-production.yml:49` |
| `AURORA_SCHEMA_FORWARD_ONLY_AUDIT` | `scripts/deploy-production.sh`<br>`scripts/verify-forward-only-boundary.mjs`<br>`.github/workflows/deploy-production.yml` |
| `AURORA_BACKUP_RESTORE_AUDIT` | `.github/workflows/deploy-production.yml` |
| `AURORA_SOURCE_BUNDLE` | `scripts/deploy-production.sh:18` |
| `AURORA_SOURCE_BUNDLE_SHA256` | `scripts/deploy-production.sh:19` |
| `AURORA_TRIGGER_WEEKLY` | `scripts/production-autopilot-engine-switch.sh:19` |
| `CI` | `.github/workflows/deploy-production.yml:130` |
| `CONFIRMATION` | `.github/workflows/production-storage-cleanup.yml:29` |
| `CURRENT_LINK` | `scripts/deploy-production.sh:98` |
| `DATABASE_URL` | `scripts/migrate.mjs:241`<br>`scripts/production-local-migration-url.mjs:40`<br>`scripts/rebase-monthly-profile-hashes.mjs:5`<br>`scripts/reencrypt-token-envelopes.mjs:5`<br>`scripts/run-production-migrations.sh:14`<br>`scripts/cleanup-media-orphans.mjs:5`<br>`scripts/production-autopilot-engine-switch.sh:56`<br>`scripts/runtime-schema-preflight.mjs:36`<br>`scripts/production-autopilot-diagnostics.sh:395`<br>`.github/workflows/deploy-production.yml:118`<br>`.github/workflows/production-release-audit.yml:81` |
| `DEPLOY_SHA` | `scripts/deploy-production.sh:44` |
| `GH_TOKEN` | `.github/workflows/deploy-production.yml:47` |
| `GITHUB_REPOSITORY` | `.github/workflows/deploy-production.yml:54` |
| `MEDIA_GLOBAL_MAX_BYTES` | `scripts/configure-media-storage-limits.mjs:14` |
| `MEDIA_OBJECT_BUCKET` | `src/lib/media-storage.mjs:16` |
| `MEDIA_OBJECT_ENDPOINT` | `src/lib/media-storage.mjs:22` |
| `MEDIA_OBJECT_FORCE_PATH_STYLE` | `src/lib/media-storage.mjs:23` |
| `MEDIA_OBJECT_REGION` | `src/lib/media-storage.mjs:17` |
| `MEDIA_OBJECT_VIDEO_THRESHOLD_BYTES` | `src/lib/media-storage.mjs:42` |
| `MEDIA_ORPHAN_CLEANUP_BATCH_SIZE` | `scripts/cleanup-media-orphans.mjs:11` |
| `MEDIA_PROJECT_MAX_BYTES` | `scripts/configure-media-storage-limits.mjs:13` |
| `MEDIA_QUOTA_DATABASE_URL` | `scripts/configure-media-storage-limits.mjs:3` |
| `MEDIA_RETENTION_AFTER_ASSET_ID` | `scripts/cleanup-unused-media.mjs:9` |
| `MEDIA_RETENTION_BATCH_SIZE` | `scripts/cleanup-unused-media.mjs:9` |
| `MEDIA_RETENTION_CREATED_BEFORE` | `scripts/cleanup-unused-media.mjs:9` |
| `MEDIA_RETENTION_DATABASE_URL` | `scripts/cleanup-unused-media.mjs:3` |
| `MEDIA_USER_MAX_BYTES` | `scripts/configure-media-storage-limits.mjs:12` |
| `NAVYAI_API_KEY` | `scripts/production-autopilot-diagnostics.sh:304` |
| `NEXT_PUBLIC_AURORA_APP_VERSION` | `.github/workflows/deploy-production.yml:154` |
| `PGSSL_REJECT_UNAUTHORIZED` | `scripts/migrate.mjs:126`<br>`scripts/runtime-schema-preflight.mjs:17` |
| `PRODUCTION_SSH_HOST` | `.github/workflows/production-ai-readiness-recovery.yml:67`<br>`.github/workflows/production-storage-inventory.yml:64`<br>`.github/workflows/production-ingress-audit.yml:57`<br>`.github/workflows/production-autopilot-diagnostics.yml:77`<br>`.github/workflows/deploy-production.yml:100`<br>`.github/workflows/production-avatar-ingress.yml:61`<br>`.github/workflows/production-release-audit.yml:60`<br>`.github/workflows/production-storage-cleanup.yml:70`<br>`.github/workflows/production-autopilot-engine-switch.yml:106` |
| `PRODUCTION_SSH_HOST_FINGERPRINT` | `.github/workflows/production-ai-readiness-recovery.yml:35`<br>`.github/workflows/production-storage-inventory.yml:32`<br>`.github/workflows/production-ingress-audit.yml:27`<br>`.github/workflows/production-autopilot-diagnostics.yml:43`<br>`.github/workflows/deploy-production.yml:71`<br>`.github/workflows/production-avatar-ingress.yml:27`<br>`.github/workflows/production-release-audit.yml:27`<br>`.github/workflows/production-storage-cleanup.yml:38`<br>`.github/workflows/production-autopilot-engine-switch.yml:60` |
| `PRODUCTION_SSH_KEY` | `.github/workflows/production-ai-readiness-recovery.yml:32`<br>`.github/workflows/production-storage-inventory.yml:29`<br>`.github/workflows/production-ingress-audit.yml:24`<br>`.github/workflows/production-autopilot-diagnostics.yml:40`<br>`.github/workflows/deploy-production.yml:68`<br>`.github/workflows/production-avatar-ingress.yml:24`<br>`.github/workflows/production-release-audit.yml:24`<br>`.github/workflows/production-storage-cleanup.yml:35`<br>`.github/workflows/production-autopilot-engine-switch.yml:57` |
| `PRODUCTION_SSH_KNOWN_HOSTS` | `.github/workflows/production-ai-readiness-recovery.yml:34`<br>`.github/workflows/production-storage-inventory.yml:31`<br>`.github/workflows/production-ingress-audit.yml:26`<br>`.github/workflows/production-autopilot-diagnostics.yml:42`<br>`.github/workflows/deploy-production.yml:70`<br>`.github/workflows/production-avatar-ingress.yml:26`<br>`.github/workflows/production-release-audit.yml:26`<br>`.github/workflows/production-storage-cleanup.yml:37`<br>`.github/workflows/production-autopilot-engine-switch.yml:59` |
| `PRODUCTION_SSH_USER` | `.github/workflows/production-ai-readiness-recovery.yml:67`<br>`.github/workflows/production-storage-inventory.yml:64`<br>`.github/workflows/production-ingress-audit.yml:57`<br>`.github/workflows/production-autopilot-diagnostics.yml:77`<br>`.github/workflows/deploy-production.yml:100`<br>`.github/workflows/production-avatar-ingress.yml:61`<br>`.github/workflows/production-release-audit.yml:60`<br>`.github/workflows/production-storage-cleanup.yml:70`<br>`.github/workflows/production-autopilot-engine-switch.yml:106` |
| `REDIS_URL` | `scripts/production-autopilot-engine-switch.sh:87`<br>`scripts/production-autopilot-diagnostics.sh:205`<br>`.github/workflows/deploy-production.yml:119` |
| `RELEASES_DIR` | `scripts/deploy-production.sh:90` |
| `RESTORE_DATABASE_URL` | `scripts/prepare-restored-publications.mjs:54` |
| `RUNNER_TEMP` | `.github/workflows/deploy-production.yml:55` |
| `SENTRY_AUTH_TOKEN` | `.github/workflows/deploy-production.yml:129` |
| `TELEGRAM_OWNERSHIP_AUDIT_DATABASE_URL` | `scripts/audit-telegram-ownership.mjs:3` |
| `TG_BOT_TOKEN` | `scripts/telegram-sandbox-smoke.mjs:25`<br>`.github/workflows/deploy-production.yml:120` |
| `TG_BOT_USERNAME` | `.github/workflows/deploy-production.yml:121` |
| `TG_CHAT_ID` | `scripts/telegram-sandbox-smoke.mjs:36`<br>`.github/workflows/deploy-production.yml:122` |
| `TG_SANDBOX_BOT_TOKEN` | `.github/workflows/telegram-sandbox-smoke.yml:20` |
| `TG_SANDBOX_BUSINESS_CONNECTION_ID` | `scripts/telegram-sandbox-smoke.mjs:45`<br>`.github/workflows/telegram-sandbox-smoke.yml:23` |
| `TG_SANDBOX_CHAT_ID` | `.github/workflows/telegram-sandbox-smoke.yml:21` |
| `TG_SANDBOX_EXPECTED_BOT_USERNAME` | `.github/workflows/telegram-sandbox-smoke.yml:22` |
| `TG_SANDBOX_EXPECTED_BUSINESS_USER_ID` | `scripts/telegram-sandbox-smoke.mjs:49`<br>`.github/workflows/telegram-sandbox-smoke.yml:24` |
| `TOKENS_KEY_ID` | `src/lib/token-crypto.mjs:38`<br>`.github/workflows/deploy-production.yml:126` |
| `TOKENS_MASTER_KEY` | `src/lib/token-crypto.mjs:37`<br>`.github/workflows/deploy-production.yml:125` |
| `TOKENS_OLD_KEYS` | `src/lib/token-crypto.mjs:42` |
| `TOKENS_REENCRYPT_BATCH_SIZE` | `scripts/reencrypt-token-envelopes.mjs:7` |
| `VK_APP_ID` | `.github/workflows/deploy-production.yml:127` |
| `VK_APP_SECRET` | `.github/workflows/deploy-production.yml:128` |

## Test-only: найдены только в тестах и CI/stability fixtures

| Имя | Исходные файлы |
| --- | --- |
| `ADMIN_ALERT_TEST_DATABASE_URL` | `src/e2e/admin-alert-delivery.integration.ts:8`<br>`src/e2e/admin-alert-recipient.integration.ts:5`<br>`.github/workflows/ci.yml:272` |
| `ADMIN_RESOURCE_TEST_DATABASE_URL` | `src/e2e/admin-resource-auth.integration.ts:11`<br>`.github/workflows/ci.yml:349` |
| `ADMISSION_WORKER_DIRECTORY` | `scripts/test-publication-adjacent-authority-integration.mjs:6` |
| `AURORA_ALLOWED_ORIGINS` | `src/lib/request-origin.test.ts:100` |
| `AURORA_E2E_VK_API_URL` | `scripts/test-e2e-real.mjs:1243` |
| `AURORA_TEMPORARY_PHONE_VERIFICATION` | `src/app/api/settings/account-profile/phone/production-contract.test.ts:33` |
| `CAPACITY_REPORT_PATH` | `scripts/test-capacity-integration.mjs:69` |
| `E2E_ADVANCE_SCHEDULE_AFTER_RESTART` | `scripts/test-e2e-real.mjs:58` |
| `E2E_ARTIFACT_DIR` | `scripts/test-e2e-real.mjs:134`<br>`scripts/test-e2e-stability.mjs:166` |
| `E2E_BROWSER` | `scripts/test-e2e-real.mjs:54`<br>`scripts/test-e2e-stability.mjs:163` |
| `E2E_BROWSER_EXECUTABLE` | `scripts/test-e2e-real.mjs:711`<br>`scripts/test-trends-hydration-e2e.mjs:65` |
| `E2E_BUILD_MODE` | `scripts/test-e2e-real.mjs:55`<br>`scripts/test-e2e-stability.mjs:164` |
| `E2E_BUILD_TIMEOUT_MS` | `scripts/test-e2e-real.mjs:56` |
| `E2E_CAPTURE_ARTIFACTS` | `src/lib/e2e-runtime-isolation.test.mjs:182`<br>`scripts/test-e2e-real.mjs:60`<br>`scripts/test-e2e-stability.mjs:165` |
| `E2E_DATABASE_URL` | `scripts/test-e2e-real.mjs:51`<br>`scripts/e2e-project-calendar-coverage.mjs:106`<br>`scripts/test-trends-hydration-e2e.mjs:11`<br>`.github/workflows/ci.yml:50`<br>`.github/workflows/e2e-stability.yml:45` |
| `E2E_FAKE_PORT` | `src/lib/e2e-runtime-isolation.test.mjs:81` |
| `E2E_REDIS_URL` | `scripts/test-e2e-real.mjs:52`<br>`scripts/test-trends-hydration-e2e.mjs:12`<br>`.github/workflows/ci.yml:51`<br>`.github/workflows/e2e-stability.yml:46` |
| `E2E_STABILITY_ARTIFACT_DIR` | `scripts/test-e2e-stability.mjs:24`<br>`.github/workflows/e2e-stability.yml:57` |
| `E2E_STABILITY_DRY_RUN` | `scripts/test-e2e-stability.mjs:26` |
| `E2E_STABILITY_ENGINES` | `scripts/test-e2e-stability.mjs:19` |
| `E2E_STABILITY_INITIAL_BUILD_MODE` | `scripts/test-e2e-stability.mjs:20` |
| `E2E_STABILITY_RUNS` | `scripts/test-e2e-stability.mjs:18`<br>`.github/workflows/e2e-stability.yml:56` |
| `E2E_TRENDS_PORT` | `scripts/test-trends-hydration-e2e.mjs:24` |
| `E2E_WEB_PORT` | `src/lib/e2e-runtime-isolation.test.mjs:80` |
| `HOME` | `scripts/telemetry-envelope-probe.mjs:44` |
| `HOSTED_PROJECTION_SOURCE` | `src/e2e/hosted-projection.integration.ts:7` |
| `HOSTNAME` | `scripts/test-e2e-real.mjs:1218`<br>`scripts/test-trends-hydration-e2e.mjs:35` |
| `ISOLATED_DATABASE_URL` | `src/e2e/telegram-ownership.integration.ts:186` |
| `MIGRATION_TEST_DATABASE_URL` | `src/e2e/publication-lifecycle.integration.ts:14`<br>`src/e2e/sites-ai-current-access.integration.ts:18`<br>`src/e2e/site-destination-identity.integration.ts:10`<br>`src/e2e/registration.integration.ts:10`<br>`src/e2e/password-recovery.integration.ts:19`<br>`src/e2e/rss-project-authorization.integration.ts:21`<br>`src/e2e/publication-operation.integration.ts:33`<br>`src/e2e/tracking-lifecycle.integration.ts:19`<br>`src/e2e/native-project-media.integration.ts:16`<br>`src/e2e/project-collaboration.integration.ts:47`<br>`src/e2e/hosted-projection.integration.ts:8`<br>`src/e2e/ai-spend-failure-reproduction.integration.ts:9`<br>`src/e2e/site-analysis-tenant.integration.ts:15`<br>`src/e2e/admin-operations-center.integration.ts:13`<br>`src/e2e/ai-orchestration.integration.ts:21`<br>`src/e2e/audience-delivery.integration.ts:15`<br>`src/e2e/ai-project-authorization.integration.ts:17`<br>`src/e2e/research-project-access.integration.ts:20`<br>`src/e2e/legacy-content-project.integration.ts:19`<br>`src/e2e/sites-revision.integration.ts:14`<br>`src/e2e/runtime-operations.integration.ts:7`<br>`src/e2e/calendar-pagination.integration.ts:11`<br>`scripts/test-telegram-delivery-integration.mjs:13`<br>`scripts/test-publication-authority-integration.mjs:13`<br>`scripts/test-media-lifecycle-integration.mjs:8`<br>`scripts/test-publication-adjacent-authority-integration.mjs:9`<br>`scripts/test-restored-publications-integration.mjs:24`<br>`scripts/test-capacity-integration.mjs:8`<br>`scripts/test-semantic-publication-integration.mjs:13`<br>`scripts/test-sites-delivery-integration.mjs:8`<br>`scripts/test-publication-quarantine-integration.mjs:11`<br>`scripts/test-schema-readiness-integration.mjs:13`<br>`scripts/test-autopilot-confirmation-integration.mjs:17`<br>`scripts/test-media-quota-integration.mjs:7`<br>`scripts/test-migrations-integration.mjs:6`<br>`.github/workflows/ci.yml:49` |
| `MIGRATION_TEST_REDIS_URL` | `scripts/test-semantic-publication-integration.mjs:14`<br>`scripts/test-publication-quarantine-integration.mjs:12`<br>`scripts/test-schema-readiness-integration.mjs:14`<br>`scripts/test-autopilot-confirmation-integration.mjs:18`<br>`.github/workflows/ci.yml:52` |
| `N21_COLLECTOR_SOURCE` | `src/e2e/research-project-access.integration.ts:80` |
| `N21_NICHE_SOURCE` | `src/e2e/research-project-access.integration.ts:63` |
| `OAUTH_WORKER_SOURCE` | `worker/oauth-publication-authority.test.mjs:4` |
| `PATH` | `worker/outbound-guard.test.mjs:8`<br>`scripts/telemetry-envelope-probe.mjs:44` |
| `PG_DUMP_BIN` | `scripts/test-restored-publications-integration.mjs:68` |
| `PG_RESTORE_BIN` | `scripts/test-restored-publications-integration.mjs:73` |
| `PGPASSWORD` | `.github/workflows/ci.yml:124` |
| `PORT` | `scripts/test-e2e-real.mjs:1219`<br>`scripts/test-trends-hydration-e2e.mjs:36` |
| `POSTGRES_DB` | `.github/workflows/ci.yml:21`<br>`.github/workflows/e2e-stability.yml:24` |
| `POSTGRES_PASSWORD` | `.github/workflows/ci.yml:20`<br>`.github/workflows/e2e-stability.yml:23` |
| `POSTGRES_USER` | `.github/workflows/ci.yml:19`<br>`.github/workflows/e2e-stability.yml:22` |
| `PROJECT_CONTEXT_TEST_DATABASE_URL` | `src/e2e/project-request-context.integration.ts:11`<br>`src/e2e/oauth-project-context.integration.ts:21`<br>`.github/workflows/ci.yml:229` |
| `PUBLICATION_LEASE_SOURCE` | `scripts/test-publication-authority-integration.mjs:12` |
| `PUBLICATION_WORKER_SOURCE` | `scripts/test-publication-authority-integration.mjs:9` |
| `RESTORE_QUARANTINE_SOURCE` | `scripts/test-restored-publications-integration.mjs:20` |
| `ROLLBACK_TARGET_DIRECTORY` | `scripts/test-rollback-target-integration.mjs:11` |
| `SENTRY_ORG` | `scripts/test-e2e-real.mjs:1209` |
| `SENTRY_PROJECT` | `scripts/test-e2e-real.mjs:1210` |
| `SENTRY_URL` | `scripts/test-e2e-real.mjs:1211` |
| `SITE_DELIVERY_WORKER_FILE` | `scripts/test-sites-delivery-integration.mjs:6` |
| `SITE_DESTINATION_SOURCE` | `src/e2e/site-destination-identity.integration.ts:9` |
| `TELEGRAM_OWNERSHIP_TEST_DATABASE_URL` | `src/e2e/telegram-ownership.integration.ts:23`<br>`.github/workflows/ci.yml:214` |
| `TZ` | `src/lib/monthly-campaign-service.test.ts:36`<br>`worker/monthly-campaign-regeneration.test.mjs:15` |
| `WORKER_MEDIA_SOURCE` | `worker/media-persistence-safety.test.mjs:7` |

## Статические ссылки без доказанного entrypoint

| Имя | Исходные файлы |
| --- | --- |
| `AURORA_RUNTIME_ROLE` | `package.json:11` |
| `AURORA_WORKER_MODE` | `package.json:44` |
| `NODE_ENV` | `package.json:12` |

## Ограничения статической проверки

Вычисляемые `env[key]`, конструируемые имена, shell sourced-файлы, косвенные вызовы
и значения из внешних runner/container/systemd конфигураций не могут быть полностью
восстановлены этим сканированием. Имена, которые читает сама платформа Next.js, Node
или внешняя библиотека без ссылки в коде проекта, не добавлялись по предположению.
Публичный `NEXT_PUBLIC_*` префикс не делает секрет безопасным: он обозначает
браузерную конфигурацию сборки. Реальные значения и согласованные лимиты требуют
отдельной разрешённой проверки перед rollout.

Места вычисляемого доступа (без выражений и значений):

- `scripts/telegram-sandbox-smoke.mjs:15`
- `scripts/test-e2e-real.mjs:98`
- `scripts/test-restored-publications-integration.mjs:114`
- `src/app/api/channels/tenchat/route.test.ts:33`
- `src/e2e/ai-spend-failure-reproduction.integration.ts:150`
- `src/e2e/ai-spend-failure-reproduction.integration.ts:164`
- `src/e2e/ai-spend-failure-reproduction.integration.ts:184`
- `src/e2e/site-destination-identity.integration.ts:21`
- `src/lib/ai-engine-policy.mjs:50`
- `src/lib/ai-generation-deadlines.ts:6`
- `src/lib/ai-spend-ledger.mjs:30`
- `src/lib/db-pool-config.mjs:35`
- `src/lib/tenchat-integration.mjs:32`
- `src/lib/tracking-secrets.ts:7`
- `src/lib/upload-ingress.mjs:10`
