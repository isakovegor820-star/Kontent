# Aurora readiness audit — 2026-08-29

Статус: рабочий реестр доказательств, **не утверждённый readiness board**.
Вердикт на текущем SHA: **NO-GO**. Документ не заменяет Product, QA, SRE,
Accessibility, Security или Legal sign-off.

## Обновление доказательств 2026-08-30

- Добавлен последовательный fail-fast runner `npm run test:e2e:stability`: по умолчанию
  30 циклов × Chromium/Firefox/WebKit, уникальные каталоги journey, manifest, SHA-256
  inventory, два trace, не менее двух video, screenshots и обезличенный network log.
  Режим меньше 30 циклов явно считается только локальной проверкой runner.
- Build/reuse привязан к SHA-256 snapshot входных файлов. Любое изменение кода, схемы
  или runtime-конфигурации во время build/journey останавливает gate; evidence от старой
  сборки нельзя переиспользовать для нового snapshot.
- Первый свежий build текущего расширившегося дерева завершился V8 OOM при стандартном
  лимите Node 26 около 2144 МБ. Добавлена проверяемая build-обёртка с bounded heap 4096 МБ
  по умолчанию (`2048..8192` для явного override). Её 31 pure/config test, ESLint и
  TypeScript прошли. Успешный production build на текущем snapshot пока **не подтверждён**:
  последующие попытки fail-closed остановлены конкурентными изменениями входных файлов.
- Локальная E2E-сборка один раз унаследовала доступный процессу `SENTRY_AUTH_TOKEN` и
  запустила `sentry-cli releases set-commits`. Прогон немедленно остановлен (exit 130).
  Итог внешней операции локально **не подтверждён**. После этого disposable E2E явно
  обнуляет Sentry credentials и отключает SDK, telemetry и release/source-map upload;
  32 соответствующих config/isolation test, ESLint и TypeScript прошли, а повторные
  build-процессы не содержали `sentry-cli`.
- Три новые контрольные попытки сохранены раздельно в
  `test-results/e2e-stability/control-build-heap-20260830`,
  `control-sentry-isolated-20260830` и `control-stable-snapshot-20260830`. Ни одна не
  считается зелёным journey: snapshot guard перечислил реально изменившиеся файлы и
  остановил выполнение до browser reset. Это доказательство fail-closed runner, а не
  доказательство стабильности продукта.
- Последний полный suite до очередной конкурентной записи прошёл: 534 test files,
  2798 tests. После более поздних изменений отдельно прошли 16 связанных unit tests,
  ESLint и TypeScript. Полный suite требуется повторить на окончательно стабильном
  snapshot; прежний результат нельзя переносить автоматически.
- Migration policy-check подтверждает 107 additive transactional migrations. Новый
  `admin-operations-center.integration.ts` не запускался: он требует отдельную локальную
  БД `aurora_migration_test`, на reset которой разрешение не предоставлялось.

### Противоречие ролей BLK-03 — требуется решение владельца

- Требование плана: критический путь для `owner/editor/viewer`.
- Текущий контракт репозитория: `owner/author/approver/publisher` в
  `src/lib/project-permissions.ts`, schema constraints, API и клиентах; роли `editor` и
  `viewer` не обнаружены. Действующий harness использует owner и reviewer, повышенного до
  publisher, и не выдаёт это за требуемую трёхролевую матрицу.
- Вариант 1 — мигрировать/переименовать роли: риск нарушения API, schema и сохранённых
  memberships; без утверждённого mapping это запрещённое изменение публичного контракта.
- Вариант 2 — утвердить явное соответствие ролей плана существующим ролям и отдельно
  решить read-only доступ: меньше миграционный риск, но бизнес-права пока не подтверждены.
- Вариант 3 — исправить формулировку плана под действующий контракт: нет риска для кода,
  но требуется Product/QA approval и изменение управляющего документа владельцем.

До решения владельца BLK-03 нельзя отметить выполненным даже после зелёных 30 циклов.

## Управляющий источник и границы аудита

- Основной источник: `План_готовности_Авроры_до_8_из_10_улучшенный.docx`.
- SHA-256 источника и копии на Desktop совпадает:
  `e3e6582110520d59e17a906e9cfa84119613dbed9f7c21bc9a1f2ebe6d0557ad`.
- Репозиторий: ветка `main`, исходный SHA
  `90701d2a2fe0e44b99a0a8b81371773d6861812e`.
- До начала исправлений рабочее дерево вложенного репозитория было чистым.
- Production-данные и внешние системы не использовались. Destructive E2E выполнялся
  только после отдельного разрешения и только на локальных disposable targets:
  PostgreSQL `aurora_e2e_real`, Redis DB 15 и `.next-e2e-real`.
- Именные владельцы, Launch Commander, подписанты и согласованный смысл «20k»
  в доступных материалах не найдены: **Требуется решение владельца**.

## F0 baseline и воспроизводимые доказательства

| Контур | Фактическое состояние | Доказательство |
| --- | --- | --- |
| Scope | Стабилизационный scope уже описан, но `/bot/connect` противоречиво попадал под experimental `/bot`. | `docs/stabilization/release-scope.md`, `src/lib/release-scope.ts` до BLK-01. |
| Маршруты | 71 `page.tsx`, 191 API `route.ts`, 21 `layout.tsx`. Расхождения с утверждённым планом нет. Build вывел 234 route artifact. | `find src/app ...`; успешный `npm run build`. `.next/app-path-routes-manifest.json` имеет 268 внутренних app-path записей — это другой счётчик, его нельзя смешивать с build route artifact. |
| Схема | 106 SQL migration; policy-check подтверждает additive/transactional форму. Локальный disposable PostgreSQL 17 использован полным browser E2E. | `npm run test:migrations` — pass; 3-engine `test:e2e:real` мигрировал и пересоздавал только `aurora_e2e_real`. |
| Redis | Локальный disposable Redis подтверждён полным browser E2E. | 3-engine `test:e2e:real` использовал только DB 15; production/live Redis не использовался. |
| Unit/contracts | 512 test files, 2673 tests прошли до изменений. | `npm test` — pass, 29.05 s. |
| Текущая регрессия | После локальных исправлений 520 test files, 2729 tests. | `npm test` — pass, 56.80 s; lint, TypeScript, focus и diff-check — pass. |
| Focus policy | Focused/skipped tests не обнаружены. | `npm run test:focus` — pass. |
| Static quality | Lint и TypeScript прошли до изменений; после BLK-01/02 также прошли. | `npm run lint`; `npx tsc --noEmit`. |
| Production build | Next 16.2.12 webpack build успешен; 234 route artifact. | `npm run build` — pass; compile 2.4 min, TypeScript 32.0 s. |
| Bundle snapshot | Сумма gzip отдельных `.next/static/chunks/*.js` — 1,425,210 bytes; крупнейший отдельный chunk — 143,618 bytes gzip. Это не route-level JS budget и не RUM/CWV. | Локальный анализ output последнего успешного build. |
| Монолиты | `worker.mjs` — 12,578 строк; Composer — 4,547; Calendar — 2,867. | `wc -l`. |
| Browser E2E | Production-topology harness fail-closed допускает только локальные disposable DB `aurora_e2e_real` и Redis DB 15. Полный критический journey прошёл в Chromium, Firefox и WebKit: `ok=true`, browser issues `0`, graceful restart/session recovery, exports и ширины 1440/1024/390/320/640. Chromium использовал реальную задержку (`fixtureClockAdvanced=false`). | `test-results/e2e-real/{chromium,firefox,webkit}/result.json` и `browser-diagnostics.json`; все три команды завершились code 0. WebKit отдельно сохранил 24 известных наблюдения, а не скрыл их: 10 событий от пяти Playwright screenshots под strict CSP, 10 отменённых RSC-prefetch и 4 отменённых Studio background request при документной навигации. |
| Event taxonomy | Минимальные имена/properties раздела 9.1 оформлены как fail-closed code contract. Production emitters, correlation envelope, sink и policy отсутствуют. | `src/lib/product-event-contract.mjs` и contract/privacy tests; это prerequisite, не funnel evidence. |
| Load/capacity | Production-like staging, утверждённый mix, load output и capacity report не предоставлены. | `docs/stabilization/release-readiness-2026-08-26.md`; локального load gate нет. |

## F0 prerequisites и состояние gate

| Требование F0 | Состояние доказательств | Статус |
| --- | --- | --- |
| Frozen scope | Есть репозиторный scope; исключение `/bot/connect` добавлено BLK-01. Утверждение Product не подтверждено. | Частично |
| Isolated staging и QA tenant | Адреса, credentials, parity manifest и безопасный reset не предоставлены. | Заблокировано |
| Именные владельцы и Launch Commander | В плане указаны только функциональные роли. | Требуется решение владельца |
| Readiness board с едиными ID | Этот файл создаёт локальную карту ID/evidence, но внешнее утверждение отсутствует. | Частично |
| Event schema и privacy/retention | Минимальный allowlist реализован; correlation, DPA/consent/retention и sink отсутствуют. | Частично / требуется решение владельца |
| Performance/bundle baseline | Build и chunk snapshot есть; CWV lab/RUM и route budgets отсутствуют. | Частично |
| Route/state matrix | Автоматический critical journey прошёл в трёх движках, двух пользовательских контекстах и пяти viewport/zoom-equivalent размерах. Полная матрица всех role/state/device и manual assistive-tech pass отсутствует. | Частично |
| Concurrency model | Не подтверждено, означает ли 20k active или simultaneous. | Требуется решение владельца |
| Матрица подписантов | Требуемые роли известны; люди и подписи отсутствуют. | Требуется решение владельца |

F0 exit gate не выполнен. Независимые локальные исправления допускаются, но release
остаётся NO-GO и результаты нельзя переносить на capacity/staging assertions.

## Карта P1

| ID | Приоритет / владелец по плану | Компоненты и доказательство | Зависимости / проверка | Состояние |
| --- | --- | --- | --- | --- |
| BLK-01 | P1; BE/FE/QA | `src/lib/release-scope.ts`, proxy, `/bot/connect`, one-time hashed session service. До исправления exact path редиректился из-за `/bot`; browser run дополнительно нашёл same-page hashchange gap. | QA tenant, Telegram stub; proxy + token/server tests; затем 3-engine browser и token scan. | **Частично:** allowlist, initial/hashchange hygiene, token/service contracts и 3-engine critical journey green. Независимый полный token/network scan и 30-run gate не подтверждены. |
| BLK-02 | P1; BE/SRE | `src/lib/db.ts` до исправления имел `max: 3` без timeout. Добавлены env policy, bounded timeouts, protected readiness pool snapshot и локальный runbook. | Staging DB/Redis, connection budget, PgBouncer/equivalent, saturation/load dashboard. | **Частично:** unit/static gates green. Реальная DB timeout integration, slow-query/transaction metric, PgBouncer, рабочий alert route и p95<50 load evidence отсутствуют. |
| BLK-03 | P1; QA/Eng | Harness автоматизирует production topology и fail-closed ограничивает reset локальными disposable DB/Redis. Три browser engines создают отдельные artifacts; test pool budgets сохранены на прежнем `3`. | QA tenant → deterministic reset/fixtures/stubs → roles → 3 engines/mobile → 30 runs. | **Частично:** локальные engine binaries установлены; разрешённый disposable reset, owner + reviewer/publisher contexts и полный Chromium/Firefox/WebKit critical journey green. Полная owner/editor/viewer матрица, 30 последовательных прогонов, flake report и внешний QA tenant отсутствуют. |
| BLK-04 | P1; Data/Product | Минимальные события/properties раздела 9.1 теперь зафиксированы fail-closed contract; доменные audit/tracking/AI signals всё ещё не образуют требуемый funnel. | DPA/consent/retention и correlation contract до sink/dashboard; schema tests и synthetic reconciliation. | **Частично / заблокировано:** code contract и privacy tests есть; emitters, correlation, sink, dashboard и решения владельца отсутствуют. |
| BLK-05 | P1; SRE/BE | Реального load output/capacity report нет. | BLK-02 + BLK-04 + production-like staging + seeded tenants; baseline/ramp/peak/spike/soak/stress. | **Заблокировано:** нет безопасного staging и утверждённой concurrency/mix/cost model. Никакие load-метрики не заявлены. |

## Карта последующего backlog

Затронутые компоненты ниже — точки аудита, а не утверждение готовности. До закрытия
пяти P1 переход к F2/F3/F4 не считается разрешённым gate.

| ID | P / фаза / роль по плану | Затронутые компоненты | Способ проверки по плану | Текущее доказательство |
| --- | --- | --- | --- | --- |
| UX-01 | P2 / F2 / Design, FE, BE | onboarding page, progress/complete API, recovery helpers | moderated critical journey, save/resume, duration truth | Есть unit/recovery coverage; полный gate не подтверждён. |
| UX-02 | P2 / F2 / Design, FE | app shell/navigation, role-aware routes | task/first-click + back/context suite | Не подтверждено. |
| UX-03 | P2 / F2 / FE | Settings/Composer forms; shared dirty-state provider не найден | Save/Discard/Stay on route/back/reload | Не подтверждено; требуется сначала shared contract. |
| UX-04 | P2 / F2 / Content, FE, BE | draft/editorial/publication clients and error copy | ACK, last-saved, retry/offline regression | Локальные ACK-aware helpers есть; end-to-end contract не подтверждён. |
| UX-05 | P2 / F2 / Design, FE | shared UI primitives and route states | loading/empty/success/warning/error/offline matrix | Полная матрица не подтверждена; route `loading.tsx` не найден. |
| UX-06 | P2 / F2 / FE, BE | account settings, calendar/timezone helpers | one searchable IANA selector + DST tests | Timezone validation/tests есть; единый UI selector не подтверждён. |
| UX-07 | P2 / F2 / Product, FE | account locale/settings and visible UI | hide English or complete i18n | Требуется решение владельца; готовность не подтверждена. |
| UX-08 | P2 / F1-F2 / Product, BE, Sec | phone request/confirm routes, runtime capability and Settings UI | production rejects temporary verification; provider flow | **Частично:** legacy flag больше не включает temporary mode в production; request/confirm fail-closed до DB, UI скрывает flow. Реальный provider и Product/Security acceptance отсутствуют. |
| TR-01 | P2 / F2 / BE, FE, Sec | sessions, account/security settings | revoke one/all, device history, expiry/multi-tab | Admin session view существует; self-service center не подтверждён. |
| TR-02 | P2 / F2 / Product, Legal | legal pages and data policy | operator/retention/subprocessors/jurisdiction/DSR sign-off | Внешний sign-off отсутствует. |
| TR-03 | P2 / F2 / Product, BE | account/project export and account controls | self-service delete/export + audit trail | Project export есть; account deletion/export gate не подтверждён. |
| A11Y-01 | P2 / F2 / FE | links/buttons/dialogs across TSX | remove 15 nested interactive patterns + CI rule | Наличие исходных 15 случаев не переподтверждено; CI rule не подтверждён. |
| A11Y-02 | P2 / F2 / Design, FE | canonical buttons/nav/form controls | automated size contract + viewport QA | Частичные component tests есть; вся поверхность не подтверждена. |
| A11Y-03 | P2 / F2 / FE | root layout, not-found/error | keyboard skip target, landmarks/headings | Полный gate не подтверждён. |
| A11Y-04 | P2 / F2 / FE, QA | dialogs, forms, live status/error UI | focus order/return, live regions, summary | Critical journey подтвердил keyboard actions и focus return экспортов/уведомлений в трёх движках; полная dynamic matrix отсутствует. |
| A11Y-05 | P2 / F2-F4 / A11y, QA | all critical screens | NVDA/VoiceOver, reduced motion, 200/400% evidence | E2E подтвердил reduced motion и 200%-equivalent viewport; NVDA/VoiceOver, 400% и внешний manual sign-off отсутствуют. |
| PERF-01 | P2 / F3 / FE | app auth guards/shell | no auth flash; boot/network trace | Не подтверждено. |
| PERF-02 | P2 / F3 / FE, BE | `worker.mjs`, Composer, Calendar | characterization + incremental split + regression | Монолиты измерены; декомпозиция не начата в этом цикле. |
| PERF-03 | P2 / F3 / FE, SRE | Next build/CI/RUM | route JS and LCP/INP/CLS budgets | Только coarse chunk baseline; CI/RUM budgets отсутствуют. |
| PERF-04 | P3 / F2-F3 / FE | route-level loading UI | slow-network stable geometry | `loading.tsx` не найден; не подтверждено. |
| REL-01 | P2 / F3 / BE, SRE | worker queues/providers, DB pool | backpressure/timeouts/retry taxonomy + alerts | Доменные retry helpers есть; единый operational gate отсутствует. |
| REL-02 | P2 / F3 / QA, Eng | E2E/integration fault harness | offline/timeout/5xx/429/409/retry | Production-topology 3-engine critical journey и offline/restart/idempotency branches green; полный fault matrix и 30-run gate отсутствуют. |
| REL-03 | P2 / F2-F3 / FE, BE | session and client stores | session expiry + multi-tab sync | Session unit tests есть; browser multi-tab gate отсутствует. |
| REL-04 | P2 / F3 / BE, QA | drafts/publication lifecycle | conflict/idempotency/reconciliation under faults | Сильные unit/integration artifacts есть; полный fault gate не перепроверен. |
| MOB-01 | P2 / F2-F4 / Design, FE, QA | shell/onboarding/composer/calendar | 320-430 + tablet + real-device/keyboard | Новый automated pass подтвердил 320/390/640/1024/1440 и keyboard journey; real-device и независимый manual pass отсутствуют. |
| DS-01 | P2 / F2 / Design Systems, FE | `src/components/ui`, tokens/state stories | canonical primitives + stories/CI | Components есть; canonical inventory/sign-off не подтверждены. |
| SEO-01 | P2 / F2 / FE, Product | root metadata, robots, sitemap, OG | crawl/preview/canonical checks | Полный contract и Product approval не подтверждены. |
| SEC-01 | P2 / F3-F4 / Security, Eng | dependencies, auth/integrations/threat model | authorized CVE scan + threat-model review | Не запускалось; внешний Security sign-off отсутствует. |
| SEC-02 | P2 / F1-F2 / FE, Platform | experimental app routes/build artifact | production artifact inventory excludes routes | Runtime fail-closed есть; build по-прежнему содержит experimental routes. |
| OPS-01 | P2 / F3-F4 / SRE | readiness, worker/queue/pool signals | SLO dashboard, alert, on-call, runbook, rollback | Readiness partial; external dashboard/alerts/on-call не подтверждены. |
| OPS-02 | P2 / F4 / all leads | deploy/canary/rollback procedures | immutable SHA rehearsal + war-room evidence | Не проводилось; требуется внешнее окружение и владельцы. |

## Обязательные решения и внешние входы

1. Назначить Launch Commander, именных owners и signer matrix.
2. Предоставить isolated QA tenant и production-like staging с disposable DB/Redis,
   provider stubs и документированным reset без production impact.
3. Утвердить DB connection budget: web, worker, migrations, admin reserve,
   PgBouncer/equivalent и общий server limit.
4. Утвердить event ownership, consent/DPA/retention и допустимую схему correlation IDs.
5. Решить, что означает business target 20k: active или simultaneous; подтвердить mix.
6. Авторизовать независимые Accessibility, Security, Legal и Product/QA gates.

Пока эти входы отсутствуют, BLK-03 остаётся частично закрытым, BLK-04/05 и F0/F1
exit gates остаются заблокированы, даже если локальные unit/build/3-engine проверки зелёные.
