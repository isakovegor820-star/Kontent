# Актуализация блокирующих дефектов «Авроры»

Дата повторной проверки: 5 августа 2026 года
Базовый commit: `b564811`
Режим: диагностика без исправления продуктового кода и без публикации тестовых материалов во внешние каналы.

Основной подробный отчёт: [REPORT.md](./REPORT.md).

## Итог

Платформа не находится в состоянии полного отказа: во время проверки web, PostgreSQL, схема, Redis, publication worker и основной AI-провайдер были доступны. Реальный безопасный запрос в Studio завершился через `navy-gpt-5-4`, request id `26aa3e47-4feb-44d9-a653-30b797f2fd69`, terminal result сохранился в `ai_usage.id=120`.

Однако production-релиз остаётся заблокированным. Главная причина — не доступность инфраструктуры, а отсутствие серверной границы доверия между исходным материалом, AI-результатом и публикуемым черновиком. Дополнительно текущая среда не умеет доставлять письма восстановления аккаунта и смены email.

Текущий подтверждённый реестр:

| Класс | Количество | Комментарий |
|---|---:|---|
| P0 | 2 | оба исходных P0 остаются в коде и данных |
| P1 | 5 | 4 исходных P1 + недоступное восстановление аккаунта |
| P2 | 11 | 9 оставшихся исходных P2 + 2 новых диагностированных |
| P3 | 1 | глобальная уборка AI reservations не подключена |
| **Всего** | **19** | текущие подтверждённые code/runtime defects |

Один дефект исходного отчёта исправлен: `AUR-P2-009`. ESLint теперь игнорирует `.next-e2e-real/**`, текущий `npm run lint` проходит.

## Критические дефекты, которые остаются

### AUR-P0-001 — исходные trend/idea/reference drafts доступны для публикации

- В браузере Calendar по-прежнему показывает полные исходные материалы как обычные черновики с активным действием планирования.
- В БД подтверждены, среди прочих, source drafts `12/v1`, `14/v1`, `16/v1`, `17/v1`, `20/v1` с `origin=trend|idea|competitor` и полным `text` источника.
- Точка нарушения: один объект `draft` одновременно играет роль непубликуемого `source_context` и публикуемой сущности.
- Риск: публикация чужого/сырого источника без адаптации и AI-проверки.
- Доказательства интерфейса: [05-calendar-internal-reference-drafts.png](./screenshots/05-calendar-internal-reference-drafts.png), [06-raw-reference-publish-enabled.png](./screenshots/06-raw-reference-publish-enabled.png).

### AUR-P0-002 — клиент всё ещё может подделать AI provenance и validation

- `parseDraftWriteInput` принимает от клиента `origin`, `sourceRef` и `aiValidation`: `src/lib/server-drafts.ts:145-236`.
- Публикационный gate разрешает любой draft с `origin !== "ai"` без AI-review: `src/lib/draft-review.ts:137-154`.
- Для `origin=ai` сервер валидирует форму metadata, но не связывает её с terminal result, request id, user, channel, source draft/version, fingerprint и ACK.
- В БД сохраняется exploit-proof `draft 19/v1`: произвольный текст, `origin=ai`, чужой произвольный `source_id`, client-forged validation `passed`.
- Риск: обход серверной валидации и публикация произвольного текста под видом проверенного AI-результата.

### AUR-P1-001…004 — исходные P1 не устранены

1. `topicFromSourceText` всё ещё ранжирует первые предложения по числу токенов и может выбрать внутреннюю фразу вместо темы: `src/lib/reference-adaptation.ts:65-82`.
2. Topic alignment остаётся лексическим stem/token-overlap guard: он блокирует корректные синонимы и пропускает token stuffing.
3. `interactiveStream || surface === "trends"` всё ещё передаётся как `allowReviewableBlockedDraft`: `src/app/api/ai/generate/route.ts:1160-1176`. Blocked/off-topic terminal result может завершиться как `done` и стать reviewable draft.
4. Autopilot хранит `editing` и `editText` вне ключа channel/plan, не отменяет предыдущий `load`, а Save использует текущий `chId`: `src/app/app/autopilot/page.tsx:110-153,363-393`.

## Новые подтверждённые дефекты

### AUR-OPS-P1-001 — восстановление аккаунта и смена email не работают

1. **Severity:** P1.
2. **Сценарий:** забытый пароль; смена email в профиле.
3. **Шаги:** открыть `/forgot-password`, ввести корректно оформленный email, нажать «Отправить инструкцию».
4. **Ожидается:** письмо ставится в outbox и доставляется; readiness сообщает capability как готовую.
5. **Фактически:** UI возвращает общий success-status, но `password_reset_outbox` остаётся пустым; email-change API возвращает `503 email_delivery_unavailable`.
6. **Доказательства:** readiness имел `status=degraded`, `mailDeliveryReady=false`, `passwordRecoveryReady=false`, reason `mail_delivery_not_configured`. В среде отсутствуют `APP_URL`, `TOKENS_MASTER_KEY`, mail API key и sender. Route молча возвращает `202` до создания outbox: `src/app/api/auth/password/forgot/route.ts:56-64`; email-change fail-fast: `src/app/api/settings/profile/email/request/route.ts:96-102`.
7. **Точка потери:** запрос пользователя заканчивается до `createPasswordResetOutboxRequest`.
8. **Корневая причина:** обязательная mail-конфигурация отсутствует; глобальный health banner скрывается, когда web/publication готовы, поэтому mail degradation не виден внутри продукта: `src/components/app/shell.tsx:217-228`.
9. **Риск:** пользователь без активной сессии не может вернуть доступ к аккаунту; смена email невозможна.
10. **Исправление:** настроить HTTPS `APP_URL`, envelope key, provider и sender; вывести capability-specific предупреждение в соответствующих формах; добавить deployment smoke-test доставки.
11. **Regression:** readiness + real outbox worker integration с fake mail endpoint; проверка, что существующий аккаунт создаёт outbox, worker помечает `sent`, токен одноразовый.
12. **Уверенность:** высокая.

### AUR-P2-011 — Studio неверно объясняет результат серверной валидации

1. **Severity:** P2.
2. **Сценарий:** ручная AI-генерация, результат требует review.
3. **Ожидается:** UI показывает реальные blocker codes и сообщает, что именно не подтверждено.
4. **Фактически:** UI всегда пишет «Смысловая проверка сейчас недоступна» при `requiresReview`: `src/app/app/studio/page.tsx:314-317`.
5. **Доказательства:** для request `26aa3e47-4feb-44d9-a653-30b797f2fd69` сервер сохранил `coverage=deterministic+semantic`, `semanticAdapter=aurora-semantic-ai-v1`, `semanticEntailment=blocked`, blocker `unsupported_semantic_claim`. Проверка была доступна и выполнена, но результат был отрицательным.
6. **Точка подмены:** UI сворачивает любое `requiresReview` в одну строку про недоступный validator.
7. **Риск:** пользователь не понимает, какие утверждения исправить или подтвердить, и может принять blocked draft за технический сбой.
8. **Исправление:** передавать и отображать безопасные blocker codes/messages; отдельно различать `not_checked`, `provider_failed` и `blocked`.
9. **Regression:** UI-тест для всех трёх состояний semantic entailment.
10. **Уверенность:** высокая.

### AUR-P2-012 — publication operation остаётся `queued` после публикации

1. **Severity:** P2.
2. **Сценарий:** создать publication operation, дождаться внешней публикации, восстановить/повторить запрос по idempotency key.
3. **Ожидается:** операция получает terminal status, согласованный с дочерними posts.
4. **Фактически:** в БД operation остаётся `queued`, outbox — `enqueued`, хотя связанный post уже `published`; строка не менялась более двух суток.
5. **Точка потери:** `refreshOperationStatus` вычисляет состояние только из `publication_outbox` и считает все `enqueued` как вечное `queued`: `src/lib/publication-outbox.mjs:5-25`. Publication worker не завершает `publication_operations` после terminal post status.
6. **Риск:** recovery/replay возвращает устаревшее состояние; UI может бесконечно показывать очередь, оператор не отличает доставленную публикацию от незавершённой.
7. **Исправление:** terminal reconciliation по связанным posts/parts; outbox должен иметь конечное состояние `completed` либо операция должна вычисляться из posts.
8. **Regression:** интеграционный тест `queued → publishing → published → operation completed`, включая replay после рестарта.
9. **Уверенность:** высокая.

### AUR-P3-001 — глобальная уборка просроченных AI reservations не вызывается

1. **Severity:** P3.
2. **Фактически:** две строки `ai_usage` пользователя QA остаются `status=reserved`, хотя `expires_at < now()` и terminal `result_payload` уже сохранён.
3. **Код:** `expireAiUsageReservations` реализован в `src/lib/ai-usage.ts:757-778`, но используется только тестом и не вызывается readiness/cron/worker.
4. **Риск:** ложные operational alerts, рост мусорного audit-state и неоднозначное восстановление terminal failures. В текущем подсчёте квоты просроченные reservations не учитываются, поэтому немедленного повторного списания не подтверждено.
5. **Regression:** worker/cron integration, который переводит только просроченные `reserved` в `expired`, не затрагивая живые leases и terminal replay metadata.
6. **Уверенность:** высокая.

## Эксплуатационные наблюдения, не включённые в defect count

- 17 из 18 Telegram-публикаций находятся в `published_unverified/unverifiable`, только одна — `published/verified`. У всех есть external id и публичный handle. Это консервативно защищает от дублей, но резко обедняет verified analytics и style memory. Требуется отдельная сверка с реальным публичным feed; без неё это operational risk, а не доказанный code defect.
- `media_generations`: 8 `ready`, 2 `failed` (`rate_limited`, `worker_failed`). Медиа в целом работает, но нужны retry/recovery smoke-tests.
- `site_analysis_jobs`: 1 `ready`, 1 `failed` с `crawl_too_large`. Это ожидаемый bounded failure, если UI предлагает понятный retry с меньшим scope.
- Текущий fallback list — `navy-gpt-5-4, navy-minimax-m3, local`; поэтому дефект Anthropic history-loss остаётся в коде, но не активен в текущей конфигурации.

## Проверки качества

| Проверка | Результат |
|---|---|
| Целевые draft/reference/AI route tests | 5 файлов, 49 тестов — passed |
| Полный `npm test` | 171 файл, 933 теста — passed |
| `npm run lint` | passed |
| `npx tsc --noEmit` | passed |
| `AURORA_NEXT_DIST_DIR=.next-audit-current npm run build` | passed, 156 static pages generated |

Прохождение тестов не снимает release blocker: P0/P1 воспроизводятся через браузер, текущие строки БД и прямое сопоставление API boundary с кодом. Это отдельный дефект покрытия.

## Рекомендуемый порядок исправлений

1. Разделить серверные сущности `source_context` и `publishable draft`; закрыть публикацию source-only records.
2. Сделать `origin`, provenance и AI validation серверными; криптографически/хешем связать terminal text с request/user/channel/source draft/version/fingerprint/ACK.
3. Убрать `allowReviewableBlockedDraft` из автоматического create-flow и запретить auto-open Composer после terminal topic/factual failure.
4. Заменить derived-topic эвристику на обязательный структурированный semantic intent и усилить alignment семантической проверкой с одним repair-pass.
5. Привязать Autopilot edit/load state к `{channelId, planId, revision, itemIdentity}` и отменять stale requests.
6. Настроить и проверить mail delivery/account recovery.
7. Закрыть terminal lifecycle publication operations и global AI reservation cleanup.
8. Исправить misleading validation copy, stale Composer/RSS/mobile/logging и latent Anthropic fallback defects.

## Ограничение повторной проверки

Во время production build в shared worktree появились несвязанные незакоммиченные изменения в site-analysis модулях. Они сохранены и не изменялись этим аудитом. Результаты unit/lint/type/build относятся к состоянию файлов на момент запуска соответствующей команды; для финального release gate их нужно повторить после стабилизации worktree.
