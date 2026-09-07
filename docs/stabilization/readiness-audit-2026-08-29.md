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
- Migration policy-check подтверждает 107 additive transactional migrations (на дату аудита; актуальное число выводит `npm run test:migrations`). Новый
  `admin-operations-center.integration.ts` не запускался: он требует отдельную локальную
  БД `aurora_migration_test`, на reset которой разрешение не предоставлялось.

## Обновление доказательств 2026-08-31

- Текущий проверенный worktree находится на ветке `codex/fix-content-studio`, HEAD
  `c1b4bc362f69ba5856357a86cc135213c8172e88`. Во время работы параллельные git-операции,
  зафиксированные reflog, несколько раз меняли `HEAD`, выполнили rebase/merge и затем
  checkout с `main` на эту ветку. Эти операции не выполнялись в рамках данного аудита;
  откат, commit и push не выполнялись.
- Для последнего локального non-browser gate зафиксирован SHA-256 snapshot E2E-входов
  `cd65d99be9532adf282b2b6a838a1fa3709c4132e05f55b5e1f64b1dd9744974`, 1674 файла.
  На неизменном snapshot прошли 546 test files / 2900 tests, 4 связанных test files /
  59 tests, ESLint, TypeScript, focus-policy, `git diff --check` и policy-check 107
  additive transactional migrations.
- `npm run build` на том же snapshot завершился code 0: webpack compile 60 s,
  встроенный TypeScript 21,4 s, static page generation 237/237. Digest после build
  совпал с исходным; результат не переносится на staging или production performance.
- Обнаруженная image-only правка Studio удаляла существующий клиентский путь видео и
  скрывала provenance резервной AI-модели, хотя API, очередь, worker и persisted media
  contract продолжают поддерживать `kind: "video"` и `veo-3.1`. В worktree восстановлены
  обратносуместимые entry points, video settings/render/retry, fallback provenance и
  регрессионные проверки; доступные image-модели по-прежнему фильтруются серверными
  capabilities. Это локальное исправление, не Product sign-off.
- Три поздние попытки 30 × 3 были корректно остановлены snapshot guard, а не продуктовым
  assertion: `blk-03-30-run-clean-snapshot-20260831-1503` — 32 зелёных journey перед
  изменением readiness route; `blk-03-30-run-readiness-snapshot-build-20260831-1601` —
  16 зелёных перед изменением harness; `blk-03-30-run-digest-5192c2f5-20260831-1635` —
  48 зелёных перед добавлением шести Calendar/stream файлов. Ни один прогон не считается
  30-run evidence.
- На snapshot `5192c2f531876ca323ec4f9ef255f9a7b28b0bfc5ff21cd26eec9b3614df3aaa`
  контроль `control-webkit-composer-save-20260831-1628` прошёл 3/3 движка, failed 0,
  flake rate 0. Этот результат нельзя автоматически переносить на текущий snapshot.
- Для BLK-01 добавлены exact synthetic canary, расширенная URL-санитизация и fail-closed
  scan текстовых evidence, структурированного network log, всех файлов и распакованного
  содержимого trace/XLSX. Read-only scan указанного предыдущего 3-engine control проверил
  по 22 файла, 7 текстовых файлов и 3 архива на движок, а также 7692 / 6544 / 6672
  network events; находок 0. Новый browser journey дополнен проверкой `/bot/connect`:
  clean URL, DOM, history evidence, recorded network URL и diagnostics, причём trace
  запускается после bounded token flow. Код и старые артефакты проверены, но этот journey
  ещё не запускался на текущем snapshot, поэтому полный token/network gate не заявляется.
- Для BLK-02 добавлена отдельная integration-проверка на новом временном PostgreSQL 16
  cluster без доступа к существующим БД. Фактически прошли 3/3 сценария: acquire timeout
  при pool max 1, server `statement_timeout` (`57014`), idle-transaction termination
  (`25P03`) и рабочий запрос после замены соединения. Успешный temp cluster остановлен,
  evidence сохранён. Это не controlled saturation/load, PgBouncer, dashboard или alert.
- Повторный аудит BLK-04 устранил устаревшее утверждение об отсутствии ingestion/storage:
  текущий код содержит authenticated `/api/product-events`, server-owned user/project,
  session/request/operation correlation, raw retention, transactional daily aggregates,
  клиентский operational emitter и admin funnel/errors/speed/events. Шесть связанных
  test files / 53 tests прошли. При этом taxonomy раздела 9.1 вызывается только тестами:
  lifecycle/worker emitters, terminal publish reconciliation ≥95%, cohort и
  freshness/volume alerts отсутствуют; consent/DPA/retention approval не предоставлен.
- Новый browser-контроль текущего snapshot не запускался: команда была отклонена до
  старта из-за destructive reset PostgreSQL `aurora_e2e_real` и Redis DB 15. Без browser
  и reset успешно выполнены dry-run `dry-run-studio-restored-20260831-1850` (1 × 3) и
  `dry-run-30x3-studio-restored-20260831-1855` (30 × 3, 90 запланированных journey),
  а после BLK-01 evidence changes — `dry-run-evidence-safety-20260831-1915` (30 × 3,
  90 запланированных journey). Финальный текущий snapshot после BLK-02 integration имеет
  отдельный `dry-run-blk01-blk02-20260831-1930` (30 × 3, 90 journey).
  Это проверка плана runner, а не продукта. Требуется отдельное явное
  разрешение на эти disposable targets; BLK-03 остаётся частичным.
## Перефиксация Stage 0 — 2026-09-01

- Финальный проверенный baseline: ветка `main`, HEAD
  `c22121a44f7a1055311b1ef3f9ef24f86e581627`, совпадает с `origin/main`.
  Reflog фиксирует переход `HEAD@{2026-08-31 22:32:30 +0400}` как внешний
  fast-forward `merge origin/main` с `980d77e` на `c22121a`. Commit создан Egor
  Isakov, parent `e7bd621`, author time `2026-08-31T20:12:05+02:00`, subject
  `Stop reading a charged quota reservation as a delivered plan`. Этот audit не
  выполнял fast-forward, reset, stash, commit или push.
- После перефиксации сохранены все пользовательские/внешние изменения. Текущий
  dirty-состав: десять modified-файлов — этот audit, два E2E runner, API/UI
  `/bot/connect` с тестами, runtime-isolation test и export service с тестом — и два
  untracked evidence-safety module/test. Ничего не удалялось, не откатывалось и не
  перезаписывалось.
- После последнего изменения E2E-входов зафиксирован SHA-256 snapshot
  `ef97867df6bb4eb9e92cf4adf4d4c33afba7d445953bb0bef0d79c5b84f7a356`
  из 1677 файлов. HEAD, `origin/main` и digest были одинаковыми до и после всех
  повторных Stage 0 проверок, отдельного Chromium diagnostic, полного 1×3 control и
  последующего 30×3 stability gate.
- На этом snapshot прошли: targeted suite 27 test files / 166 tests; полный
  `npm test` 548 files / 2922 tests; ESLint; `tsc --noEmit`; focus-policy без
  focused/skipped tests; migration policy для 107 additive transactional migrations;
  production build; `git diff --check`. Production build: Next 16.2.12, webpack
  compile 75 секунд, встроенный TypeScript 14,6 с, static page generation
  237/237.
- Route/policy inventory после build: 71 `page.tsx`, 194 API `route.ts`, 21
  `layout.tsx`, 271 запись в `.next/app-path-routes-manifest.json`; route/proxy policy
  tests прошли 3 files / 13 tests. `/bot/connect` остаётся stable-исключением внутри
  experimental `/bot`. При этом production artifact всё ещё содержит 34 legacy/preview
  routes (`/cycle`, `/finale`, `/footer`, `/how`, `/memory`, `/old`, `/quality`,
  `/reasons`, `/rss`, `/scroll-test`, `/v2`, `/v3`, `/variants` и дочерние пути).
  Поэтому F0-01/SEC-02 не закрыты и Product approval не заявляется.
- Свежий local-disposable control 1×3 прошёл в каталоге
  `test-results/e2e-stability/control-runtime-restart-idle-main-c22121a-20260901-run01`:
  3/3 journey, failed 0, flake-rate 0, неожиданных browser/runtime errors и diagnostic
  issues 0. Chromium/Firefox/WebKit записали соответственно 8302/7340/7483 network
  events; scanner проверил по 22 evidence-файла, 7 text evidence и 3 раскрытых архива
  на engine, все четыре canary обнаружены самим scanner, findings 0.
- Control подтвердил состояния unknown, malformed, expired, pending/valid, connected,
  unauthorized и used/reused; контракты 401 и 410; multi-tab consumption;
  refresh/back/forward/reopen; сохранение исходного владельца connection; только digest
  токена в PostgreSQL; чистые telemetry tables. URL, history, DOM, browser/server logs,
  network log, diagnostics и trace не содержали token canary; trace начинался только
  после consumption. Использовались исключительно разрешённые local-disposable
  PostgreSQL `aurora_e2e_real`, Redis DB 15, `.next-e2e-real` и synthetic fixtures;
  production/live targets не использовались.
- До зелёного control runner честно остановил несколько неуспешных попыток. В частности,
  `...-2315`, `...-2332` и WebKit diagnostic `...-2352` зафиксировали отмену WebKit
  запроса `/api/auth/me`: переход с `/login` начинался после `domcontentloaded`, пока
  first-party auth loader ещё работал. После ожидания first-party network idle
  `diagnostic-webkit-login-idle-main-c22121a-20260901-0003` прошёл 1/1, а затем прошёл
  полный 1×3. Неуспешные результаты не засчитаны как product evidence.
- Первая попытка полного 30×3 в
  `test-results/e2e-stability/stability-30x3-main-c22121a-20260901-run01` остановилась
  fail-fast на cycle 11/WebKit: 32 journey прошли, 33-й завершился с семью WebKit
  access-control cancellations параллельных Studio loaders. Причина — harness после
  Library → Studio ждал URL, но делал намеренный provider-replay reload до завершения
  first-party запросов. Добавлено ожидание first-party network idle перед reload и
  regression contract. Старый run имеет status `failed`, failed 1/33, flake-rate 3,03%
  и не засчитывается. На новом digest отдельный
  `diagnostic-webkit-studio-idle-main-c22121a-20260901-run01` прошёл 1/1, а затем прошёл
  новый полный 1×3. Старый 30×3 результат остаётся невалидным.
- Вторая попытка полного 30×3 в
  `test-results/e2e-stability/stability-30x3-main-c22121a-6c0a90d2-run02` остановилась
  fail-fast на cycle 3/Chromium: 6 journey прошли, 7-й обнаружил две строки с одним
  monthly title в export preview (`Найдено строк: 2`). Trace подтвердил продуктовую
  причину: экспорт включал несвязанный item из superseded revision месячного плана
  вместе с опубликованным post. Run имеет status `failed`, failed 1/7, flake-rate
  14,29% и не засчитывается. Export query теперь исключает items из superseded plan
  revisions; SQL contract покрыт regression test, а E2E сначала требует `rowCount === 1`
  и только затем проверяет title. На новом digest Chromium diagnostic
  `diagnostic-chromium-current-plan-export-main-c22121a-20260901-run01` прошёл 1/1,
  затем свежий полный 1×3 прошёл 3/3. Последующий run03 был начат с нуля.
- Третья попытка полного 30×3 в
  `test-results/e2e-stability/stability-30x3-main-c22121a-b1e7c95f-run03` остановилась
  fail-fast на cycle 11/Chromium: 30 journey прошли, 31-й получил один reviewer
  `console.error` для `/api/rss/items?summary=unread` — `net::ERR_TOO_MANY_RETRIES`.
  Run имеет status `failed`, failed 1/31, flake-rate 3,23% и не засчитывается. Network
  log показал один failed request, а следующий poll и все последующие получили 200.
  Trace локализовал harness race: после намеренного full-runtime restart reviewer reload
  увидел heading, окно ожидаемых restart transport errors закрылось, а Chromium доставил
  отложенный console event ещё через ~84 мс. Теперь обе восстановленные вкладки требуют
  750 мс first-party idle до закрытия restart-window; порядок покрыт regression contract.
  На новом digest отдельный
  `diagnostic-chromium-runtime-restart-idle-main-c22121a-20260901-run01` прошёл 1/1,
  затем свежий полный 1×3 прошёл 3/3. Последующий run04 был начат с нуля.
- Четвёртая попытка полного 30×3 в
  `test-results/e2e-stability/stability-30x3-main-c22121a-ef97867d-run04` прошла:
  status `passed`, 90/90 journey, failed 0, flake-rate 0, все exit codes 0. Прогон шёл
  с `2026-09-01T03:25:41.454Z` до `2026-09-01T10:30:44.359Z` (425,05 минуты) на
  неизменном snapshot `ef97867d…a356`: по 30 Chromium/Firefox/WebKit. Во всех journey
  browser runtime errors, diagnostic issues и evidence-safety findings равны 0.
  Scanner проверил 1980 evidence-файлов, включая 630 text evidence и 270 раскрытых
  архивов; каждый journey содержит 22 файла, два trace, video, screenshots и network
  log. Всего проверено 700459 network events: Chromium 250712, Firefox 221882, WebKit
  227865. После завершения HEAD и `origin/main` остались `c22121a…`, повторный snapshot
  сохранил тот же digest и 1677 файлов, `git diff --check` прошёл.
- Зелёный 30×3 закрывает локальный stability-критерий, но не заменяет approved role
  matrix, отдельный QA tenant, load/capacity или внешние QA/privacy sign-off. Итоговый
  release verdict остаётся **NO-GO**.

## Продолжение BLK-02 — 2026-09-01

- После завершения 30×3 изменены DB observability inputs, поэтому текущий E2E snapshot
  теперь `a4ed9bbf72436624048aa2ce5d41ad2ac9d7a73a5bfc5a0f45995ea051a4b03f`
  из 1681 файла. Результат 90/90 относится только к прежнему `ef97867d…a356` и не
  переносится на новое дерево; свежий 30×3 до фиксации baseline не заявляется.
- `DatabasePoolMonitor` schema v2 теперь отдаёт process-scoped bounded aggregates:
  query duration p95/max, query samples, slow-query/timeout/error counters,
  transaction duration p95/max, active/commit/rollback/abandoned/error counters. Порог
  slow query конфигурируется `AURORA_DB_SLOW_QUERY_MS`; SQL и параметры в snapshot не
  сохраняются. Авторизованные readiness/admin diagnostics получают эти поля через
  существующий `getDatabasePoolSnapshot()`.
- Добавлен fail-closed `npm run test:db-pool:integration`: только loopback и точное имя
  disposable БД `aurora_e2e_real`, без schema reset. Два идентичных прогона подтвердили
  bounded acquire timeout при `max=1`, server statement timeout `57014`, rollback и
  восстановление соединения. В обоих прогонах acquire p95 был 152 мс; transaction
  duration 331/330 мс. Это намеренная локальная saturation fixture, а не целевой
  load-gate `p95 <50 ms`.
- На snapshot `a4ed9bbf…b03f` прошли targeted 4 files / 26 tests, полный `npm test`
  549 files / 2928 tests, ESLint, TypeScript, focus-policy, migration policy 107 и
  production build Next 16.2.12: compile 2,1 минуты, TypeScript 27,7 с, pages 237/237.
  `git diff --check` прошёл до build.
- Во время этой работы внешний fetch передвинул только tracking ref `origin/main` с
  `c22121a…` на `1ed8c68a0807b32e85fe06bc181da93a5370db52` (merge PR #9,
  `Restore Studio media flow and harden readiness evidence`); локальный HEAD остался
  `c22121a…` и теперь behind 7. Incoming commit пересекается с dirty audit/E2E/package
  файлами, поэтому merge/fast-forward автоматически не выполнялся и пользовательские
  изменения не перезаписывались. До решения этого расхождения baseline не считается
  финально замороженным.

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

## Повторный Stage 0 после Git reconciliation — 2026-09-02

- Ветка `main` выровнена: локальный `HEAD` и `origin/main` равны
  `fdc11b00785e8d178bb390b84a0a75c6f978e139`. По Git metadata этот внешний commit
  `Classify WebKit Studio navigation cancellations` создан `Egor
  <ваш-email@example.com>` 2026-09-01T19:38:22+04:00 и имеет parent
  `60ad7fcb078ddf746bb02bdf26b78cae23f9d2bf` (`Show live stats for channel posts`).
  Dirty readiness-изменения сохранены поверх него: 27 modified и 4 untracked файла.
  Дополнительно сохранены recoverable stashes `c462eb1607f3…` и `75e0fa1e0d7e…`, а
  также backups `/private/tmp/aurora-git-reconcile.OLm7Un`,
  `/private/tmp/aurora-git-reconcile-2.pT2DqJ` и
  `/private/tmp/aurora-stage0-candidate-4.WqjDuE`. Ничего не удалялось.
- Финальный E2E input snapshot после исправления project invitation hydration race —
  `c582283be07ca60168caeb8646bc40835a0d641c03627b33f6f2a68ee3660354`, 1687
  файлов. На нём прошли targeted suite 19 files / 175 tests, полный `npm test` 551
  files / 2940 tests, ESLint, TypeScript, focus-policy без focused/skipped tests,
  migration policy для 107 additive transactional migrations и `git diff --check`.
  Production build Next 16.2.12 прошёл: compile 3,7 минуты, TypeScript 27,8 секунды,
  static pages 237/237. Build inventory по-прежнему содержит legacy/experimental
  routes, поэтому SEC-02/F0-01 не объявляются закрытыми.
- Локальная fail-closed DB integration на disposable `aurora_e2e_real` прошла:
  acquire saturation timeout, statement timeout, rollback и connection recovery.
  Намеренная `max=1` fixture дала acquire p95 152 мс, query p95 325 мс и transaction
  p95 327 мс. Это не staging load evidence и не подтверждение целевого p95 <50 мс
  или 30% headroom.
- Предыдущий run
  `stability-30x3-main-fdc11b0-48ab1807-run01` остановился на cycle 2/WebKit:
  Playwright успел заполнить SSR controlled input до подключения React, а submit после
  hydration валидировал пустое state. Trace подтвердил валидный
  `qa-approver@aurora.test` в DOM перед submit и отсутствие POST. Форма приглашения
  теперь inert/disabled до client hydration и публикует явный interactive marker;
  harness ждёт marker перед вводом. Regression contracts и отдельный WebKit diagnostic
  `test-results/e2e-real/webkit-hydration-fix` прошли; failed run не засчитывается.
- Свежий control
  `test-results/e2e-stability/control-1x3-main-fdc11b0-c582283b-run01` прошёл 3/3:
  failed 0, flake-rate 0, browser runtime errors 0, diagnostic issues 0 и scanner
  findings 0. Network events: Chromium 8609, Firefox 7470, WebKit 7556; по 22
  evidence-файла на engine.
- Свежий обязательный run
  `test-results/e2e-stability/stability-30x3-main-fdc11b0-c582283b-run01` прошёл
  с 2026-09-01T17:06:30.538Z до 2026-09-02T00:04:42.906Z: status `passed`, 90/90,
  failed 0, flake-rate 0. Все 30 Chromium, 30 Firefox и 30 WebKit journeys имеют
  browser runtime errors 0, diagnostic issues 0 и evidence-safety findings 0.
  Scanner проверил 1980 файлов, 630 text evidence и 270 раскрытых архивов; всего
  699844 network events (Chromium 250277, Firefox 221545, WebKit 228022).
  После terminal manifest повторный snapshot сохранил тот же digest и 1687 файлов;
  `HEAD`, `origin/main` и `git diff --check` не изменились.
- Локальные BLK-01 browser/evidence и BLK-03 stability критерии тем самым подтверждены
  для текущего digest. Они не заменяют внешний QA/Privacy sign-off, утверждённый role
  mapping, отдельный QA tenant, real-device/manual pass, staging capacity или другие
  обязательные подписи. Release verdict остаётся **NO-GO**.

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
| Маршруты | 74 `page.tsx`, 209 API `route.ts`, 22 `layout.tsx`; build manifest содержит 287 app-path. Production artifact всё ещё включает 31 legacy/experimental route по утверждённому audit-pattern. | `rg --files src/app`; `.next/app-path-routes-manifest.json`; route/proxy policy targeted tests — pass. |
| Схема | 109 SQL migrations; policy-check подтверждает additive/transactional форму. Локальный disposable PostgreSQL 17 использован свежим browser E2E. | `npm run test:migrations` — pass; browser gate мигрировал и пересоздавал только `aurora_e2e_real`. |
| Redis | Локальный disposable Redis подтверждён полным browser E2E. | 3-engine `test:e2e:real` использовал только DB 15; production/live Redis не использовался. |
| Unit/contracts | 512 test files, 2673 tests прошли до изменений. | `npm test` — pass, 29.05 s. |
| Текущая регрессия | На финальном snapshot `1cccdbbf…a71ea` прошли targeted 48 files / 350 tests и полный `npm test` 564 files / 3037 tests. | ESLint, TypeScript, focus, migration policy 109, dependency audit, isolated DB integration, production build и `git diff --check` — pass; digest до и после browser gate одинаков. |
| Focus policy | Focused/skipped tests не обнаружены. | `npm run test:focus` — pass. |
| Static quality | Lint и TypeScript прошли до изменений; после BLK-01/02 также прошли. | `npm run lint`; `npx tsc --noEmit`. |
| Production build | Next 16.2.12 webpack build успешен; 239/239 pages generated. | На snapshot `1cccdbbf…a71ea` `npm run build` — pass; artifact inventory отдельно подтверждает 31 legacy/experimental route, поэтому SEC-02 остаётся открытым. |
| Bundle snapshot | Сумма gzip отдельных `.next/static/chunks/*.js` — 1,425,210 bytes; крупнейший отдельный chunk — 143,618 bytes gzip. Это не route-level JS budget и не RUM/CWV. | Локальный анализ output последнего успешного build. |
| Монолиты | `worker.mjs` — 12,578 строк; Composer — 4,547; Calendar — 2,867. | `wc -l`. |
| Browser E2E | Свежие control 1×3 и stability 30×3 прошли на текущем snapshot `1cccdbbf…a71ea`: 3/3 и 90/90, flake-rate 0, runtime errors 0, diagnostic issues 0, evidence-safety findings 0. | `test-results/e2e-stability/control-1x3-detached-78441de-1cccdbbf-run01/manifest.json`; `test-results/e2e-stability/stability-30x3-detached-78441de-1cccdbbf-run02/manifest.json`; повторный snapshot и `git diff --check` — pass. |
| Event taxonomy | Минимальные имена/properties раздела 9.1 оформлены как fail-closed contract. Отдельный generic operational-контур имеет authenticated ingestion, server-owned tenant, correlation, raw storage, retention, daily aggregates и admin funnel/errors/speed/events. Минимальная taxonomy не подключена к lifecycle/worker emitters; policy approval и terminal reconciliation отсутствуют. | `src/lib/product-event-contract.mjs`, `src/lib/product-events.ts`, `/api/product-events`, `AuroraProductTelemetry`, admin analytics; полный suite текущего snapshot — pass. |
| Load/capacity | Production-like staging, утверждённый mix, load output и capacity report не предоставлены. | `docs/stabilization/release-readiness-2026-08-26.md`; локального load gate нет. |

## F0 prerequisites и состояние gate

| Требование F0 | Состояние доказательств | Статус |
| --- | --- | --- |
| Frozen scope | Есть репозиторный scope; исключение `/bot/connect` добавлено BLK-01. Утверждение Product не подтверждено. | Частично |
| Isolated staging и QA tenant | Адреса, credentials, parity manifest и безопасный reset не предоставлены. | Заблокировано |
| Именные владельцы и Launch Commander | В плане указаны только функциональные роли. | Требуется решение владельца |
| Readiness board с едиными ID | Этот файл создаёт локальную карту ID/evidence, но внешнее утверждение отсутствует. | Частично |
| Event schema и privacy/retention | Минимальный allowlist и отдельный generic ingestion/storage/retention/aggregate контур реализованы; lifecycle mapping, terminal reconciliation, DPA/consent/retention approval отсутствуют. | Частично / требуется решение владельца |
| Performance/bundle baseline | Build и chunk snapshot есть; CWV lab/RUM и route budgets отсутствуют. | Частично |
| Route/state matrix | Автоматический critical journey прошёл в трёх движках, двух пользовательских контекстах и пяти viewport/zoom-equivalent размерах. Полная матрица всех role/state/device и manual assistive-tech pass отсутствует. | Частично |
| Concurrency model | Не подтверждено, означает ли 20k active или simultaneous. | Требуется решение владельца |
| Матрица подписантов | Требуемые роли известны; люди и подписи отсутствуют. | Требуется решение владельца |

F0 exit gate не выполнен. Независимые локальные исправления допускаются, но release
остаётся NO-GO и результаты нельзя переносить на capacity/staging assertions.

## Карта P1

| ID | Приоритет / владелец по плану | Компоненты и доказательство | Зависимости / проверка | Состояние |
| --- | --- | --- | --- | --- |
| BLK-01 | P1; BE/FE/QA | `src/lib/release-scope.ts`, proxy, `/bot/connect`, one-time hashed session service. До исправления exact path редиректился из-за `/bot`; прежний browser run дополнительно нашёл same-page hashchange gap. Different-user reuse теперь fail-closed возвращает `used` без раскрытия confirmer identity. | QA tenant, Telegram stub; proxy + token/server tests; затем 3-engine browser и token scan. | **Частично:** stable allowlist и token/service contracts green. Свежие 1×3 и 30×3 подтвердили unknown/malformed/expired/pending/connected/unauthorized/used, 401/410, refresh/back/forward/reopen и multi-tab; URL/DOM/history/network/logs/diagnostics/trace clean, scanner findings 0. Внешний QA/privacy sign-off отсутствует. |
| BLK-02 | P1; BE/SRE | Добавлены per-role pool policy, bounded timeouts, protected readiness snapshot, process-scoped query/transaction duration и timeout/error counters, runbook и local-disposable integration. | Staging DB/Redis, connection budget, PgBouncer/equivalent, saturation/load dashboard. | **Частично:** unit/static/build gates green; два идентичных local integration run подтвердили acquire/statement timeout, rollback и recovery. Не утверждены connection budget и PgBouncer; нет multi-process telemetry backend, рабочего внешнего alert route, controlled staging saturation/load/soak, p95<50 и 30% headroom evidence, Backend/SRE sign-off. |
| BLK-03 | P1; QA/Eng | Harness автоматизирует production topology и fail-closed ограничивает reset локальными disposable DB/Redis. Три browser engines создают отдельные artifacts; исторические failed/invalid попытки сохранены отдельно и не засчитаны. | QA tenant → deterministic reset/fixtures/stubs → roles → 3 engines/mobile → 30 runs. | **Частично:** свежий current-digest gate прошёл 90/90, flake-rate 0, runtime/diagnostic/safety findings 0 и полный evidence inventory. Отсутствуют утверждённый owner/editor/viewer mapping, отдельный QA tenant, обязательные 375/430/768 и real-device/manual проверки и внешний QA sign-off. |
| BLK-04 | P1; Data/Product | Минимальные события/properties раздела 9.1 зафиксированы fail-closed. Generic operational ingestion/storage/aggregate/admin dashboard реализованы отдельно. | DPA/consent/retention approval; lifecycle/worker mapping; schema tests, synthetic reconciliation ≥95%, privacy review, cohort и freshness/volume alerts. | **Частично / требуется решение владельца:** correlation/storage/retention mechanics и generic dashboard есть. Минимальная taxonomy не подключена к terminal backend/worker lifecycle; ≥95%/100% reconciliation, cohort/alerts и privacy approval отсутствуют. |
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
| REL-02 | P2 / F3 / QA, Eng | E2E/integration fault harness | offline/timeout/5xx/429/409/retry | Production-topology 3-engine critical journey, offline/restart/idempotency branches и 30×3 stability gate green; полная fault matrix отсутствует. |
| REL-03 | P2 / F2-F3 / FE, BE | session and client stores | session expiry + multi-tab sync | Session unit tests и `/bot/connect` multi-tab/reuse browser branch green; общий session-expiry/multi-tab gate отсутствует. |
| REL-04 | P2 / F3 / BE, QA | drafts/publication lifecycle | conflict/idempotency/reconciliation under faults | Сильные unit/integration artifacts есть; полный fault gate не перепроверен. |
| MOB-01 | P2 / F2-F4 / Design, FE, QA | shell/onboarding/composer/calendar | 320-430 + tablet + real-device/keyboard | Новый automated pass подтвердил 320/390/640/1024/1440 и keyboard journey; real-device и независимый manual pass отсутствуют. |
| DS-01 | P2 / F2 / Design Systems, FE | `src/components/ui`, tokens/state stories | canonical primitives + stories/CI | Components есть; canonical inventory/sign-off не подтверждены. |
| SEO-01 | P2 / F2 / FE, Product | root metadata, robots, sitemap, OG | crawl/preview/canonical checks | Полный contract и Product approval не подтверждены. |
| SEC-01 | P2 / F3-F4 / Security, Eng | dependencies, auth/integrations/threat model | authorized CVE scan + threat-model review | `npm audit --omit=dev --audit-level=high` прошёл с 0 vulnerabilities; threat model, review подтверждённых findings и внешний Security sign-off отсутствуют. |
| SEC-02 | P2 / F1-F2 / FE, Platform | experimental app routes/build artifact | production artifact inventory excludes routes | Runtime fail-closed есть; текущий build по-прежнему содержит 31 legacy/experimental route. |
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
exit gates остаются заблокированы, даже при зелёных локальных unit/build/1×3/30×3
проверках.

## Финальная локальная ревалидация после Git reconciliation — 2026-09-03

Этот раздел является текущим оперативным итогом и заменяет более ранние snapshot-статусы
выше только там, где они противоречат приведённым здесь фактам. Исторические failed и
invalidated runs сохранены как диагностическое evidence и не засчитаны.

### Git, сохранность изменений и freeze

- После появления двух новых внешних commits `d3d5cfdec4e2d7f6be055eb242466b99d1a97a12`
  (`Deploy production from verified source bundle`) и
  `faf475625350a043f3fb41e5714cf485fffe31aa`
  (`Verify source bundle inside release repository`) локальный tracking/UI commit был
  аккуратно перебазирован поверх нового `origin/main`. Итоговый `main`/candidate HEAD —
  `78441de3af3f472fd8c68fa8cd64c7627f6cdef0` (`Improve tracking analytics onboarding`),
  его parent — `faf4756…`; ветка впереди origin на один commit.
- Финальная read-only проверка GitHub `refs/heads/main` и локального `origin/main`
  вернула один и тот же SHA `faf475625350a043f3fb41e5714cf485fffe31aa`.
- Все пользовательские readiness-изменения сохранены: 34 modified и 4 untracked файла.
  Все 1759 E2E inputs одинаковы в shared worktree и frozen candidate; единственное
  позднее расхождение dirty-файлов — этот аудит, намеренно финализированный в shared
  после freeze. Ничего не удалялось. Дополнительно сохранены семь recovery stashes; верхний —
  `9271aa236b0472f78f563c9c42fbe7087b538dfa`
  (`codex-preserve-after-e2e-3586bf46`).
- Проверки выполнены в detached frozen candidate
  `/private/tmp/aurora-readiness-05b7b397`, чтобы внешний процесс не мог изменить
  test inputs во время длинного gate. Финальный E2E snapshot —
  `1cccdbbf4243321679a61ff4643ddc0acc9b931ffae881c0eaa560e20d0a71ea`,
  1759 файлов; digest до control, до 30×3 и после terminal manifest совпал.

### Повторный Stage 0 на финальном digest

- Targeted suite: 48 files / 350 tests — pass. Полный `npm test`: 564 files /
  3037 tests — pass. ESLint, TypeScript, focus-policy без focused/skipped tests,
  migration policy для 109 additive transactional migrations и `git diff --check` —
  pass.
- `npm audit --omit=dev --audit-level=high` завершился с 0 vulnerabilities.
- Fail-closed DB integration на disposable PostgreSQL `aurora_e2e_real` подтвердила
  acquire saturation timeout, statement timeout, rollback и connection recovery.
  Намеренная `max=1` fixture показала acquire p95 153 мс, query p95 252 мс и
  transaction p95 256 мс. Это integration-proof поведения, а не staging SLO
  `pool wait p95 <50 ms` и не доказательство 30% headroom.
- Production build Next 16.2.12 прошёл: compile 20,6 с, internal TypeScript 16,9 с,
  pages 239/239. Artifact inventory содержит 287 app-path и 31 legacy/experimental
  route (`/cycle`, `/finale/*`, `/footer/*`, `/how/*`, `/memory/*`, `/quality/*`,
  `/rss*`, `/v2`, `/v3`, `/variants/*`, `/scroll-test`, `/old`), поэтому
  SEC-02/F0-01 не закрыты.

### Свежий BLK-03 browser gate на финальном digest

- На промежуточном snapshot `5f081aaf…6038` control прошёл 3/3, но первая попытка
  30×3 корректно остановилась на cycle 4/Firefox после десяти зелёных journey:
  клиент видел terminal operation вместе со старой monthly-plan revision из-за
  READ COMMITTED read skew и прекращал polling. Run
  `stability-30x3-detached-78441de-5f081aaf-run01` имеет status `failed` и не
  засчитывается. Backend теперь отдаёт `resultPlanId`, а клиент продолжает polling,
  пока result plan не появился в том же detail snapshot; добавлены service/client
  regression tests.
- После исправления финальный digest стал `1cccdbbf…a71ea`. Свежий control
  `control-1x3-detached-78441de-1cccdbbf-run01` прошёл 3/3, failed 0,
  flake-rate 0. Runtime errors, diagnostic issues и safety findings равны 0;
  network events: Chromium 8394, Firefox 7468, WebKit 7644; по 22 evidence-файла
  на engine.
- Обязательный run
  `stability-30x3-detached-78441de-1cccdbbf-run02` прошёл с
  `2026-09-03T02:10:14.076Z` до `2026-09-03T09:28:12.384Z`: status `passed`,
  90/90, failed 0, flake-rate 0, по 30 Chromium/Firefox/WebKit. Все browser runtime
  errors, diagnostic issues и evidence-safety findings равны 0. Scanner проверил
  1980 evidence-файлов, 630 text evidence и 270 раскрытых архивов; проверено
  703823 network events: Chromium 252471, Firefox 223158, WebKit 228194.
- После terminal manifest повторный snapshot сохранил точный digest
  `1cccdbbf4243321679a61ff4643ddc0acc9b931ffae881c0eaa560e20d0a71ea` и 1759
  inputs; HEAD и dirty inventory не изменились, `git diff --check` прошёл.
- Финальные control/90× и диагностический failed-run скопированы из frozen candidate
  в игнорируемый Git каталог `test-results/e2e-stability` shared worktree. Полное
  рекурсивное `diff -qr` трёх source/destination деревьев прошло без расхождений;
  evidence сохранено и в candidate, и в рабочем workspace.

### Фактическая граница локального результата

- Локально закрыты повторный Stage 0, current-digest control 1×3 и stability 30×3,
  включая token/PII evidence scanner. Это не является полным release GO.
- BLK-01 всё ещё требует внешнего QA/Privacy sign-off.
- BLK-02 всё ещё требует утверждённых лимитов web/worker/migrations/admin,
  PgBouncer/equivalent, межпроцессного telemetry backend, рабочих alerts/escalation,
  staging saturation/load/soak, p95 <50 мс, 30% headroom и Backend/SRE sign-off.
- BLK-03 всё ещё требует approved role mapping, отдельного QA tenant, недостающих
  375/430/768 и real-device/manual проверок и внешнего QA sign-off.
- BLK-04 всё ещё требует реальных lifecycle/terminal backend/worker emitters,
  synthetic reconciliation ≥95%/100%, consent/DPA/retention и privacy approval.
- BLK-05 остаётся заблокированным BLK-02/04, production-like staging и утверждённым
  concurrency/load/cost model; capacity/SLO assertions не заявляются.
- F2–F4 требуют внешних Product/Design/Accessibility/Security/Legal/SRE решений,
  NVDA/VoiceOver и real-device passes, production-like fault/capacity tests,
  canary/rollback rehearsal и восемь реальных подписей. Ни одна подпись не
  симулирована. До этих входов общий launch verdict остаётся **NO-GO**.

## Авторитетная локальная ревалидация — 2026-09-06/07

Этот раздел является текущей коррекцией и заменяет более ранние snapshot-статусы выше
там, где они противоречат приведённым здесь фактам. Он описывает frozen working tree,
на котором реально выполнены проверки, а не более новый remote ref.

### Provenance, freeze и новый remote ref

- Проверенный detached candidate расположен в
  `/private/tmp/aurora-readiness-20260906.SbKsPN`; его `HEAD` и `HEAD` shared worktree —
  `637caf85bc258d3cfed2f79dea4e202c6ee29eed` (`Improve tracking analytics
  onboarding`). До control, до stability gate и после terminal manifest candidate и
  shared имели один E2E input snapshot
  `5184b02d60b566da7731ea460c6433789a17411dbe29fc52123403b11748ab78`,
  1836 файлов. `git diff --check` прошёл.
- На момент финальной проверки tracking ref `origin/main` уже равен
  `9fe2c9961e5d01056c5f420d765f56b43c690e68`, поэтому локальная `main` отстаёт на
  четыре commits. Они меняют `scripts/test-e2e-real.mjs` и
  `src/app/app/settings/page.tsx`; green evidence автоматически на этот remote SHA не
  переносится. Merge/rebase/reset не выполнялись, frozen candidate не изменялся.
- Все незакоммиченные изменения сохранены: 35 modified и 7 untracked файлов в shared
  и candidate. Позднее изменение Settings было сохранено и вошло в проверенный digest.
  Recovery stash `96e6edbf9ff50bb16e66a9890b0221fb291e38b7` также сохранён; ничего не удалялось.

### Повторный Stage 0 на digest `5184b02d…ab78`

- Targeted suite: 27 files / 278 tests — pass. Полный `npm test`: 589 files / 3189
  tests — pass. ESLint, `tsc --noEmit`, focus-policy без focused/skipped tests,
  migration policy для 112 additive transactional migrations и production dependency
  audit с 0 vulnerabilities — pass.
- Production build Next 16.2.12 прошёл: compile 27,8 с, internal TypeScript 20,5 с,
  static pages 246/246. В build manifest 296 app-path; source inventory содержит 74
  `page.tsx`, 218 API `route.ts` и 22 `layout.tsx`. Artifact всё ещё содержит 34
  legacy/preview route, поэтому SEC-02/F0-01 не закрыты.
- Прямой fail-closed integration против disposable PostgreSQL 17
  `aurora_e2e_real` подтвердил acquire saturation timeout, statement timeout,
  transaction rollback и connection recovery. Намеренная `max=1` fixture показала
  acquire p95 152 мс, query p95 256 мс и transaction p95 262 мс. Отдельная полностью
  изолированная integration прошла 1 file / 3 tests; evidence сохранено в
  `/var/folders/l8/4bbq39ws6vz8d9h3dlt95k180000gn/T/aurora-db-pool-timeout-95OgoE`.
- Web и worker используют один monitored pool contract с раздельными per-role limits,
  bounded acquire/query/statement/idle-transaction timeouts и process-scoped
  query/transaction metrics. Это локальная проверка поведения, а не PgBouncer,
  межпроцессная telemetry, staging p95 <50 мс или доказательство 30% headroom.

### Диагностические попытки перед финальным gate

- Четыре failed control-каталога сохранены и не засчитаны. Run01 остановился до
  browser journey из-за отсутствующего `pgvector` в новом PostgreSQL 16. Run02 выявил
  устаревшее browser-ожидание после усиления privacy response `/bot/connect`; contract
  и expectation согласованы. Run03 дал ложные PII findings из бинарных членов trace ZIP;
  scanner теперь разбирает только текстовые entries. Run04 прошёл Chromium journey, но
  Info-ZIP воспринял `[Content_Types].xml` как wildcard; точное escaping `[`, `?`, `*`
  покрыто regression tests. Ни одна из этих попыток не объявлена product evidence.
- Финальный evidence scanner ищет token canaries, чувствительные query/JSON/Bearer
  значения, email и международные телефоны в network events, обычных текстовых файлах
  и текстовых members ZIP/XLSX. Synthetic reserved domains/addresses разрешены.
  `imageOcr: false`: пиксели PNG/WebM не проходят OCR, поэтому findings 0 нельзя
  трактовать как доказательство отсутствия PII внутри изображений или видео.

### Финальный BLK-03 browser gate

- Control `control-1x3-detached-637caf8-5184b02d-run05` прошёл с
  `2026-09-06T14:32:20.575Z` до `2026-09-06T14:47:16.131Z`: 3/3, failed 0,
  flake-rate 0. Chromium/Firefox/WebKit дали 8611/7504/7679 network events; runtime
  errors, diagnostic issues и evidence-safety findings равны 0.
- Обязательный `stability-30x3-detached-637caf8-5184b02d-run01` прошёл с
  `2026-09-06T14:48:00.513Z` до `2026-09-06T22:05:43.305Z`: status `passed`, 90/90,
  failed 0, flake-rate 0, по 30 Chromium/Firefox/WebKit. Во всех journeys runtime
  errors, diagnostic issues и safety findings равны 0. Scanner проверил 1980
  evidence-файлов, 630 обычных text evidence, 270 раскрытых архивов, 1080 текстовых
  archive entries и 715586 network events: Chromium 257446, Firefox 226295, WebKit
  231845.
- Control (145 MiB, 67 файлов) и stability evidence (4,1 GiB, 1981 файл) скопированы
  в игнорируемый Git каталог `test-results/e2e-stability` shared worktree. Полный
  рекурсивный `diff -qr` source/destination прошёл; SHA-256 terminal manifests совпали:
  `07f33a0d363850f445b104510c0d0f00b5f637a84ffe1b1d114baba284868b42` и
  `5783e20d5bdc45061191601258889cfca14baac0b58d1f3c2e0eaecd3ce19861`.

### Фактическая граница результата

- Локальные Stage 0, control 1×3 и stability 30×3 зелёные только для frozen digest
  `5184b02d…ab78` на `637caf8`. Более новый `origin/main` не проверен этим gate.
- BLK-01 всё ещё требует внешнего QA/Privacy sign-off. BLK-02 требует утверждённого
  connection budget, PgBouncer/equivalent, межпроцессной telemetry, рабочих alerts,
  production-like staging saturation/load/soak, p95 <50 мс, 30% headroom и
  Backend/SRE sign-off. BLK-03 требует approved role mapping, отдельного QA tenant,
  недостающих 375/430/768, real-device/manual pass и внешнего QA sign-off.
- BLK-04 всё ещё требует реальных lifecycle/terminal emitters, reconciliation
  ≥95%/100%, consent/DPA/retention и privacy approval. BLK-05 остаётся заблокированным
  без BLK-02/04, production-like staging и утверждённого concurrency/load/cost model.
  Восемь реальных подписей, canary/rollback rehearsal и внешние Product/Design/
  Accessibility/Security/Legal/SRE gates отсутствуют. Итоговый launch verdict —
  **NO-GO**.
