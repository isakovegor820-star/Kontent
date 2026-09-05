# Aurora release scope

Состояние: весь включённый продукт на кандидате исправлений аудита 2026-09-05. Исходный SHA `2161d5d0ba7b73143a3a353565015f68bb1a7fa4`; окончательный SHA и допуск — в IMPLEMENTATION-RESULT.md рядом с PLAN-ALL.md. Наличие функции в этом документе не является доказательством её production readiness.

## Включённый продукт

| Раздел | Серверные возможности | Обязательная проверка |
| --- | --- | --- |
| Аккаунт / настройки | Регистрация, пароль/сессии, logout, recovery, email change, аватар, export | registration, password-recovery, session/epoch, profile tests |
| Проекты / бренд | Выбор проекта, команды/роли, приглашения/отзыв, профиль и источники | project-collaboration, two-window project isolation, AI authorization |
| Редактор / календарь | Черновики, exact revision approval, медиа, schedule/change/cancel, history/export | publication-operation/lifecycle, calendar pagination, three-engine E2E |
| Telegram | Подтверждённый actor + project/chat proof; текст/изображение/видео/альбом, pin/first comment, analytics | ownership/replay/race + durable unknown/restart, разрешённый live sandbox |
| VK | Ключ сообщества, wall text, first comment, comment controls, analytics; media публикация остаётся unsupported по существующему реестру | provider contracts, fake VK E2E, live sandbox |
| AI / Studio / Autopilot / Today | Interactive и monthly generation, legal visuals/video, orchestration, reservations/ack, media jobs | authorization, attempts/spend caps, prompt evidence, exact approved revision, full worker E2E |
| Источники / знания / рост | RSS, Library, Trends/Radar/Recon, Opportunities/Growth/Knowledge, Site Analysis | tenant/security corpus, SSRF, background jobs, Trends hydration |
| Sites / WordPress | Domain verification, анализ/отчёты, редакции статей; hosted и WordPress publish/update/unpublish | Sites role/destination matrix, SSRF, durable unknown, fake и разрешённые live contracts |
| Admin | Межпроектные read-only отчёты, публикационные действия, блокировка/сессии/reset/AI-квота аккаунта с аудитом | admin allowlist/negative tests, verified identity, mutation audit |

Весь `/app` и соответствующий API входят в область. `EXPERIMENTAL_APP_PATH_PREFIXES` и `EXPERIMENTAL_API_PATH_PREFIXES` пусты. Никакая подписанная пользовательская функция не исключена в рамках исправлений. `/app` показывает Today; календарь доступен отдельно. Фактическую навигацию задаёт существующий AppShell.

`provider-capabilities.mjs` остаётся источником поддерживаемых социальных операций/форматов. YouTube/Instagram не получают Composer publish только от наличия OAuth credential. TenChat требует официальный доступ и предлагает export; RSS является источником. Это существующие capability ограничения, не новое сокращение релиза.

Публичные варианты `/old`, `/v2`, `/v3`, `/variants`, `/scroll-test`, `/finale`, `/footer`, `/cycle`, `/memory`, `/quality`, `/reasons`, `/how`, `/bot`, `/rss` остаются preview-only по `release-scope.ts`. Точное исключение `/bot/connect` доступно для одноразовой Telegram привязки. Preview flag не меняет scope подписанного приложения.

## Гарантии и эксплуатационные границы

- Каждая операция проверяет действующую сессию, текущие права и явный контекст проекта; внешний аккаунт требует отдельного подтверждения.
- Неопределённая доставка не становится автоматическим resend. Отсутствие receipt или slug у провайдера не доказывает отсутствие внешнего эффекта.
- Расходный AI ledger отделён от возврата пользовательского кредита. Денежные/storage caps и тарифы должен принять владелец; тестовые числа не являются production бюджетом.
- Admin user-ID allowlist привязан к серверной личности. Email allowlist требует подтверждения текущего адреса через одноразовый mailbox flow; самостоятельная регистрация адреса недостаточна. Исторические адреса автоматически не подтверждаются.
- Браузерный gate проекта — Chromium, Firefox, WebKit и 30×3 stability. Headless engines не заменяют физические устройства, настоящий zoom и screen reader; фактическое покрытие указывается в итоговом отчёте.
- Production read-only inventory, collector exposure, live sandbox, billing, backup/restore, rollback target, RPO/RTO, нагрузочный профиль, legal/privacy и владельцы alerts принимаются отдельно на основании evidence.

## Поддержка границ

Новая server capability одновременно обновляет этот документ, реестр, permission matrix и регрессию. Исправления не обходят readiness, миграционный ledger, checksum или rollback gates. Локальный запуск: `npm run dev` с web и полным worker. Отдельно разрешённый deploy выполняется установленным GitHub workflow после зелёного CI; подробности — AGENTS.md и operational runbooks.
