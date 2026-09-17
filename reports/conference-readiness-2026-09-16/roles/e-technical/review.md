# Роль Д — технический тестировщик

Дата: 2026-09-16  
Срез кода: `0bc9df3`  
Режим проверки: код, SQL-миграции и безопасные unit/contract-тесты; без браузера, внешних отправок и изменений данных.

## Итог

Серверный контур черновиков, версий, проектной изоляции, согласования и публикационной очереди в целом спроектирован существенно надёжнее обычного демонстрационного прототипа. Защитные свойства подтверждены 209 прошедшими unit/contract-тестами в 29 файлах. Особенно сильны: optimistic concurrency для черновиков, immutable revision/hash для согласования, единая операция на утверждённую ревизию, durable outbox и остановка автоматического повтора при неопределённой внешней доставке.

Однако до публичного заявления «отзыв прав действует мгновенно для уже начатых операций» есть подтверждённый статический разрыв: большинство транзакционных write-path проверяют membership без блокировки строки участника. Кроме того, согласование не реализует обязательный принцип четырёх глаз — approver/owner технически может согласовать собственный материал. Это надо либо исправить, либо честно формулировать на конференции как текущую модель ролей, а не независимый комплаенс-контроль.

## Уровни доказательств

- **Тестом** — выполненный в этом прогоне unit/contract-тест завершился успешно.
- **Кодом** — контракт прослежен до SQL/транзакции/очереди, но не исполнялся на реальной PostgreSQL/Redis.
- **Не проверено** — нужна отдельная disposable-БД/Redis или реальный внешний провайдер; текущая QA DB не затрагивалась.

## Находки

### T-01 — P1: отзыв роли не полностью ограждает уже начатую транзакцию

Статус: **подтверждено кодом; конкурентный integration-тест отсутствует**.

`requireProjectPermission` прямо предусматривает `FOR SHARE`, чтобы право не могло истечь до commit ([src/lib/project-permissions.ts:116](../../../../src/lib/project-permissions.ts#L116), [src/lib/project-permissions.ts:125](../../../../src/lib/project-permissions.ts#L125)). Публикация использует этот режим корректно — повторно проверяет `content.publish` внутри транзакции с `{ lock: true }` ([src/app/api/publication-operations/route.ts:378](../../../../src/app/api/publication-operations/route.ts#L378), [src/app/api/publication-operations/route.ts:385](../../../../src/app/api/publication-operations/route.ts#L385)).

Но `requireSelectedProjectPermission` не принимает режим блокировки и делает обычный `SELECT` ([src/lib/project-permissions.ts:145](../../../../src/lib/project-permissions.ts#L145), [src/lib/project-permissions.ts:162](../../../../src/lib/project-permissions.ts#L162)). Поэтому следующие write-path сначала читают право, затем блокируют только бизнес-объект:

- редактирование черновика: membership без lock, затем `FOR UPDATE` черновика ([src/lib/server-drafts.ts:1443](../../../../src/lib/server-drafts.ts#L1443), [src/lib/server-drafts.ts:1446](../../../../src/lib/server-drafts.ts#L1446), [src/lib/server-drafts.ts:1448](../../../../src/lib/server-drafts.ts#L1448));
- отправка и решение по согласованию: membership без lock, затем workflow/request locks ([src/lib/editorial-approval.ts:822](../../../../src/lib/editorial-approval.ts#L822), [src/lib/editorial-approval.ts:829](../../../../src/lib/editorial-approval.ts#L829), [src/lib/editorial-approval.ts:972](../../../../src/lib/editorial-approval.ts#L972), [src/lib/editorial-approval.ts:979](../../../../src/lib/editorial-approval.ts#L979));
- изменение роли и отзыв участника: проверка `members.manage` без lock выполняется до блокировки набора владельцев ([src/lib/project-context.ts:253](../../../../src/lib/project-context.ts#L253), [src/lib/project-context.ts:264](../../../../src/lib/project-context.ts#L264), [src/lib/project-context.ts:300](../../../../src/lib/project-context.ts#L300), [src/lib/project-context.ts:309](../../../../src/lib/project-context.ts#L309));
- создание/отзыв приглашения: та же последовательность ([src/lib/project-team.ts:386](../../../../src/lib/project-team.ts#L386), [src/lib/project-team.ts:387](../../../../src/lib/project-team.ts#L387), [src/lib/project-team.ts:455](../../../../src/lib/project-team.ts#L455), [src/lib/project-team.ts:456](../../../../src/lib/project-team.ts#L456)).

При стандартном `READ COMMITTED` возможна интерливинг-гонка: транзакция A читает активную роль; транзакция B отзывает её и commit; транзакция A после этого получает lock на черновик/workflow/целевого участника и завершает изменение уже после отзыва. Последовательные запросы после отзыва закрыты корректно, но «revoke wins against an in-flight write» не гарантирован.

Риск: бывший участник в узком конкурентном окне может сохранить черновик, отправить/утвердить согласование или изменить состав команды после отзыва прав.

Критерий исправления: все транзакционные write-path должны удерживать membership/project lock до commit (`requireProjectPermission(..., { lock: true })` либо эквивалент), а disposable-PostgreSQL тест должен детерминированно разыгрывать revoke против draft edit, approval decision и member mutation.

### T-02 — P1 для комплаенс-заявлений: принцип четырёх глаз не обеспечен

Статус: **подтверждено кодом; это может быть продуктовой политикой, но не независимым согласованием**.

Роль `approver` одновременно имеет `content.create`, `content.edit`, `content.submit`, `content.review` и `content.approve`; `owner` имеет все права ([src/lib/project-permissions.ts:31](../../../../src/lib/project-permissions.ts#L31), [src/lib/project-permissions.ts:39](../../../../src/lib/project-permissions.ts#L39)). В `decideDraftEditorialRequest` проверяется только `content.approve`, точная request/revision/hash/version и состояние workflow; запрета `actor == revision.author` или `actor == requested_by_user_id` нет ([src/lib/editorial-approval.ts:972](../../../../src/lib/editorial-approval.ts#L972), [src/lib/editorial-approval.ts:979](../../../../src/lib/editorial-approval.ts#L979), [src/lib/editorial-approval.ts:998](../../../../src/lib/editorial-approval.ts#L998), [src/lib/editorial-approval.ts:1015](../../../../src/lib/editorial-approval.ts#L1015)).

Следствие: технически approver/owner может создать, отредактировать, отправить и сам утвердить материал. Журнал и неизменяемая ревизия сохраняются, но независимого второго лица система не требует.

Честная формулировка для конференции: «Аврора разделяет возможности автора, согласующего и издателя и хранит доказуемую историю решений; обязательное согласование другим человеком пока не является системной политикой».

Критерий исправления, если нужен юридический four-eyes control: проектная настройка `selfApprovalAllowed=false`, запрет решения для автора/инициатора ревизии на сервере, DB/contract tests для owner и approver, а также понятное сообщение в UI.

### T-03 — P2: idempotency ключ черновика глобален для пользователя, а replay lookup — проектный

Статус: **подтверждено кодом; негативного теста нет**.

Схема содержит `unique (user_id, client_key)`, без `project_id` ([db/migrations/20260801_server_drafts.sql:15](../../../../db/migrations/20260801_server_drafts.sql#L15), [db/migrations/20260801_server_drafts.sql:22](../../../../db/migrations/20260801_server_drafts.sql#L22)). Создание делает `ON CONFLICT (user_id, client_key) DO NOTHING`, но после конфликта ищет строку уже по `project_id + user_id + client_key` ([src/lib/server-drafts.ts:1213](../../../../src/lib/server-drafts.ts#L1213), [src/lib/server-drafts.ts:1221](../../../../src/lib/server-drafts.ts#L1221), [src/lib/server-drafts.ts:1255](../../../../src/lib/server-drafts.ts#L1255)). Если тот же ключ повторно попадёт в другой проект, insert проиграет глобальному unique, проектный lookup ничего не найдёт и выбросит обычную ошибку ([src/lib/server-drafts.ts:1263](../../../../src/lib/server-drafts.ts#L1263)); API превратит её в `500 server` ([src/app/api/drafts/route.ts:51](../../../../src/app/api/drafts/route.ts#L51), [src/app/api/drafts/route.ts:61](../../../../src/app/api/drafts/route.ts#L61)).

Обычный клиент создаёт случайный ключ, поэтому вероятность мала. Реальный путь — сохранённая/offline копия, импортированное состояние либо повтор после переключения проекта. Поведение fail-closed и не раскрывает чужой черновик, но даёт неразрешимый для пользователя 500 вместо нового черновика или понятного конфликта.

Критерий исправления: согласовать DB unique и lookup на одной области (`project_id, user_id, client_key`) либо возвращать явный `409 idempotency_scope_conflict`; добавить тест повторного POST с одним ключом в двух проектах.

## Проверенная карта контрактов

| Контракт | Фактическое поведение | Доказательство | Статус |
|---|---|---|---|
| Сохранение и reload черновика | POST сохраняет в PostgreSQL; GET/PATCH читают выбранный проект; client outbox пишет последнюю ревизию синхронно и удаляет только точный server ACK | [src/lib/server-drafts.ts:1165](../../../../src/lib/server-drafts.ts#L1165), [src/lib/draft-outbox.ts:76](../../../../src/lib/draft-outbox.ts#L76), [src/lib/draft-outbox.ts:126](../../../../src/lib/draft-outbox.ts#L126) | **Тестом** |
| Double-click / повтор POST | UI объединяет быстрые save в один promise; сервер возвращает существующий draft по client key, не переписывая destinations | [src/lib/draft-client.test.ts:60](../../../../src/lib/draft-client.test.ts#L60), [src/lib/server-drafts.test.ts:732](../../../../src/lib/server-drafts.test.ts#L732) | **Тестом**, с T-03 |
| Две вкладки / stale edit | PATCH требует version; draft берётся `FOR UPDATE`; CAS update увеличивает version; конфликт возвращает текущую серверную версию и HTTP 409 | [src/lib/server-drafts.ts:1448](../../../../src/lib/server-drafts.ts#L1448), [src/lib/server-drafts.ts:1528](../../../../src/lib/server-drafts.ts#L1528), [src/lib/server-drafts.test.ts:1020](../../../../src/lib/server-drafts.test.ts#L1020) | **Тестом** |
| Project isolation | Запрос привязан к server-captured project context; draft/channel/revision/publication SQL повторяет `project_id`; произвольный ID соседнего проекта не выдаётся | [src/lib/project-permissions.ts:124](../../../../src/lib/project-permissions.ts#L124), [src/lib/server-drafts.test.ts:376](../../../../src/lib/server-drafts.test.ts#L376), [src/lib/editorial-approval.ts:558](../../../../src/lib/editorial-approval.ts#L558) | **Тестом** на mock/contract; real PostgreSQL pending |
| Роли | author: create/edit/submit; approver: create/edit/submit/review/approve; publisher: publish; owner: все права | [src/lib/project-permissions.ts:31](../../../../src/lib/project-permissions.ts#L31), [src/lib/project-permissions.test.ts:10](../../../../src/lib/project-permissions.test.ts#L10) | **Тестом**, с T-02 |
| Последний владелец | Полный набор active owners блокируется в детерминированном порядке; последнего owner нельзя понизить или отозвать; member version закрывает stale tab | [src/lib/project-context.ts:216](../../../../src/lib/project-context.ts#L216), [src/lib/project-context.ts:253](../../../../src/lib/project-context.ts#L253), [src/lib/project-context.test.ts:49](../../../../src/lib/project-context.test.ts#L49) | **Тестом** на unit; реальная concurrent DB проверка pending |
| Revoke/recheck | Новый запрос каждый раз читает активную membership из DB; уже начатые write-транзакции не все удерживают membership lock | [src/lib/project-permissions.ts:77](../../../../src/lib/project-permissions.ts#L77), [src/lib/project-permissions.test.ts:24](../../../../src/lib/project-permissions.test.ts#L24) | **Частично; T-01** |
| Согласование | Submit/decision привязаны к exact revision id + SHA-256 content hash + workflow/request versions; edit инвалидирует старое approval; evidence immutable | [src/lib/editorial-approval.ts:679](../../../../src/lib/editorial-approval.ts#L679), [src/lib/editorial-approval.ts:1000](../../../../src/lib/editorial-approval.ts#L1000), [src/lib/editorial-approval.ts:1106](../../../../src/lib/editorial-approval.ts#L1106), [db/migrations/20260812_editorial_approval.sql:140](../../../../db/migrations/20260812_editorial_approval.sql#L140) | **Тестом**, без four-eyes |
| Публикация только утверждённого | Publisher permission повторно блокируется в транзакции; операция получает immutable approved revision/version/hash; DB FK и unique не допускают другую lineage или дубль | [src/app/api/publication-operations/route.ts:385](../../../../src/app/api/publication-operations/route.ts#L385), [src/app/api/publication-operations/route.ts:526](../../../../src/app/api/publication-operations/route.ts#L526), [src/app/api/publication-operations/route.ts:1058](../../../../src/app/api/publication-operations/route.ts#L1058), [db/migrations/20260821_approved_publication_lineage.sql:21](../../../../db/migrations/20260821_approved_publication_lineage.sql#L21) | **Тестом** на unit; real DB pending |
| Одновременные publish-clicks | Любые publisher actors сходятся к одной operation на approved revision; posts уникальны по operation+destination; replay возвращает существующее состояние | [src/app/api/publication-operations/route.test.ts:769](../../../../src/app/api/publication-operations/route.test.ts#L769), [db/migrations/20260802_publication_operations.sql:24](../../../../db/migrations/20260802_publication_operations.sql#L24), [db/migrations/20260802_publication_operations.sql:33](../../../../db/migrations/20260802_publication_operations.sql#L33) | **Тестом** на unit; parallel PostgreSQL pending |
| Durable queue / retry | PostgreSQL outbox — источник владения; due row забирается `FOR UPDATE SKIP LOCKED`; lease восстанавливается; failure получает exponential backoff; operation status выводится из children | [src/lib/publication-outbox.mjs:64](../../../../src/lib/publication-outbox.mjs#L64), [src/lib/publication-outbox.mjs:99](../../../../src/lib/publication-outbox.mjs#L99), [src/lib/publication-outbox.mjs:149](../../../../src/lib/publication-outbox.mjs#L149) | **Тестом** на unit; real Redis pending |
| Worker duplicate fence | Job содержит immutable project + schedule revision; атомарный claim принимает только scheduled/due failed_retry; непосредственно перед provider call ставится второй DB fence | [worker/publication-lease.mjs:1](../../../../worker/publication-lease.mjs#L1), [worker/publication-lease.mjs:52](../../../../worker/publication-lease.mjs#L52), [worker/publication-lease.test.mjs:5](../../../../worker/publication-lease.test.mjs#L5) | **Тестом** |
| Неопределённая доставка | Если provider мог принять запрос, статус становится `published_unverified`, reconcile pending, auto-retry отключён во избежание дубля | [worker.mjs:2107](../../../../worker.mjs#L2107), [worker.mjs:2111](../../../../worker.mjs#L2111), [src/lib/social-provider-contract.mjs:20](../../../../src/lib/social-provider-contract.mjs#L20) | **Тестом** |
| Fail-closed providers | Live publish разрешён только когда capability registry говорит `supported`; неизвестный provider, VK, YouTube/Instagram Composer и TenChat live path блокируются до provider write | [src/lib/provider-capabilities.mjs:123](../../../../src/lib/provider-capabilities.mjs#L123), [src/lib/provider-capabilities.mjs:152](../../../../src/lib/provider-capabilities.mjs#L152), [src/lib/provider-capabilities.mjs:202](../../../../src/lib/provider-capabilities.mjs#L202), [src/lib/provider-capabilities.mjs:250](../../../../src/lib/provider-capabilities.mjs#L250), [src/app/api/publication-operations/route.ts:723](../../../../src/app/api/publication-operations/route.ts#L723) | **Тестом** |

## Результаты тестов текущего прогона

1. Основной набор: 22 test files, 164 tests — **passed**. Покрыты draft persistence/replay/CAS, client outbox, permissions, last owner, invitations, editorial exactness/race, publication idempotency/lineage/outbox/lifecycle, project-scoped worker lease и provider boundary.
2. Provider-delivery набор: 7 test files, 45 tests — **passed**. Покрыты Telegram multipart/carousel partial/unknown delivery, YouTube/Instagram ambiguous responses, VK provider identity/reconciliation, publication state и quarantine.
3. Итого: **29 файлов, 209 тестов, 0 падений**.

Это unit/contract доказательство с mock DB/queue там, где указано. Оно не заменяет реальную транзакционную гонку PostgreSQL, restart Redis/BullMQ и внешний sandbox-провайдер.

## Что намеренно не запускалось

Следующие тесты требуют уничтожения схемы в отдельной disposable-среде и поэтому не были перенаправлены на текущую QA DB:

- publication operation: требует локальную `aurora_publication_gate_test` и делает `drop schema public cascade` ([src/e2e/publication-operation.integration.ts:33](../../../../src/e2e/publication-operation.integration.ts#L33), [src/e2e/publication-operation.integration.ts:107](../../../../src/e2e/publication-operation.integration.ts#L107));
- publication lifecycle: тот же disposable database contract и schema reset ([src/e2e/publication-lifecycle.integration.ts:14](../../../../src/e2e/publication-lifecycle.integration.ts#L14), [src/e2e/publication-lifecycle.integration.ts:97](../../../../src/e2e/publication-lifecycle.integration.ts#L97));
- project collaboration: `aurora_publication_gate_test`, schema reset, включая настоящий concurrent last-owner test ([src/e2e/project-collaboration.integration.ts:47](../../../../src/e2e/project-collaboration.integration.ts#L47), [src/e2e/project-collaboration.integration.ts:80](../../../../src/e2e/project-collaboration.integration.ts#L80), [src/e2e/project-collaboration.integration.ts:345](../../../../src/e2e/project-collaboration.integration.ts#L345));
- project request isolation: требует disposable `aurora_launch_test` и сбрасывает schema ([src/e2e/project-request-isolation.integration.ts:29](../../../../src/e2e/project-request-isolation.integration.ts#L29), [src/e2e/project-request-isolation.integration.ts:44](../../../../src/e2e/project-request-isolation.integration.ts#L44));
- полный real E2E: требует `aurora_e2e_real` и Redis DB 15; не запускался.

До устранения T-01 и исполнения этих integration-наборов статус транзакционных/очередных гарантий — **условно готово, не сертифицировано end-to-end**.

## Бизнес-инварианты, которые нельзя ломать

1. Проект берётся из server-captured request context; client project id не является авторизацией.
2. Каждая write-операция должна повторно проверять active membership и удерживать её неизменной до commit.
3. В проекте всегда остаётся хотя бы один active owner.
4. Черновик изменяется только по текущей version; stale вкладка получает конфликт, а не last-write-wins.
5. Согласование относится к точной immutable revision/hash; содержательное редактирование аннулирует approval.
6. Публикуется только утверждённый snapshot; операция не пересобирается из поздней версии черновика.
7. PostgreSQL outbox — источник правды; Redis/BullMQ — восстановимый транспорт.
8. После начала provider call неопределённый результат нельзя автоматически отправлять повторно.
9. Неподдерживаемый provider должен завершаться fail-closed, без false-success и без фоновых повторов.

## Ответы на неудобные вопросы аудитории

- **«Две вкладки могут затереть текст?»** Нет: сервер использует version/CAS и возвращает 409 с текущей версией. Реальный multi-tab browser-сценарий в этой роли не запускался.
- **«Автор может сам опубликовать?»** Нет для роли author: publish permission отсутствует. Owner может всё.
- **«Согласование гарантированно сделано другим человеком?»** Нет. История и точная ревизия гарантированы, независимый второй человек — нет (T-02).
- **«Отозванный сотрудник сразу теряет возможность завершить уже начатое действие?»** Для нового запроса — да; для уже начатых draft/editorial/team транзакций есть гонка T-01. Публикационный create-path защищён membership lock.
- **«Повторный клик создаст два поста?»** Unit-контракты и уникальные ключи сходятся к одной операции/одному destination. Настоящий parallel PostgreSQL+Redis test пока pending.
- **«Что если сеть приняла пост, но ответ потерялся?»** Аврора помечает результат `published_unverified` и не отправляет повтор автоматически, чтобы не создать дубль.
- **«Куда сейчас реально публикует Композитор?»** По текущему capability registry live path открыт для Telegram. VK fail-closed до проверки auth flow; YouTube/Instagram не поддержаны Composer payload; TenChat — export package, live publish требует официального доступа.

## Решение по конференционной готовности технического контура

- Для демонстрации сохранения, conflict handling, согласования точной ревизии и Telegram queue/recovery — **можно показывать после отдельного end-to-end прогона**.
- Нельзя заявлять мгновенный revoke для in-flight операций или обязательный four-eyes approval.
- Перед сильными заявлениями о надёжности публикации нужны green disposable PostgreSQL/Redis integration suites и внешний Telegram sandbox proof; этот отчёт их не подменяет.
- Код и данные в рамках роли не изменялись; добавлен только этот отчёт.
