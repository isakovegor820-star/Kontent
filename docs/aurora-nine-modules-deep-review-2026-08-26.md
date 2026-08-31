# Глубокое ревью девяти модулей Aurora

Дата ревью: 26 августа 2026 года.  
Объект: текущий `main` (`636109d`) и локальный preview-runtime с
`NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES=1`.

## Итоговый вердикт

Девять модулей образуют связную продуктовую систему, но пока не являются одним
готовым production-продуктом. Они намеренно исключены из стабильного релиза: в обычном
runtime страницы перенаправляются в календарь, а API скрыты за `404`. Это правильная
защита текущего стабильного контура, но одновременно означает, что выпускать эти
разделы как «работающие постоянно и без багов» сейчас нельзя.

Сильнее всего технически выглядят «Автопилот» и «Анализ сайта». Ближе всего к полезному
ежедневному продукту — «Сегодня» и «Студия контента». Главные системные разрывы:

1. Не везде выдержаны project/team scope: часть данных и AI-контекста всё ещё привязана
   к пользователю или каналу, а не к проекту и его ролям.
2. «Развитие» строит новую доску по открытию экрана, а «Карта возможностей» зависит от
   уже существующих ходов этой доски. Фоновый цикл не гарантирует появление свежей
   недельной стратегии без посещения UI.
3. «Радар» имеет развитый поисковый backend, но отдельный продуктовый экран фактически
   отсутствует: `/app/radar` перенаправляет в интернет-режим «Трендов».
4. Надёжные очереди и reconciliation реализованы неравномерно. В этом ревью исправлена
   потеря pending-индексации в «Базе знаний», но аналогичный принцип нужно формально
   проверить для каждого фонового процесса.
5. Нет полного production-topology E2E, browser matrix, нагрузочного профиля, fault
   injection, backup/restore rehearsal и сквозной наблюдаемости для всех девяти модулей.
6. Основные страницы и `worker.mjs` остаются большими монолитами. Это не обязательно
   ломает продукт сегодня, но резко повышает стоимость изменений и вероятность
   регрессий.

Нулевого количества дефектов нельзя честно гарантировать ни одному живому продукту.
Реальная цель — измеримые SLO, безопасная деградация, идемпотентность, автоматическое
восстановление и быстрый rollback. Пока перечисленные ниже gates не зелёные, общий
решение — **NO-GO для публичного выпуска всех девяти модулей**.

## Как проводилось ревью

- изучены UI, route handlers, бизнес-библиотеки, миграции, очереди и worker-процессы;
- проверен stable/experimental release boundary;
- подняты Next.js, PostgreSQL, Redis и полный worker локально;
- просмотрены все девять разделов в авторизованной сессии;
- проверены desktop и mobile layout, ошибки консоли, horizontal overflow, доступные
  имена интерактивных элементов и duplicate IDs;
- выполнены unit/contract проверки, TypeScript и статические проверки;
- существующие readiness-документы сверены с фактическим runtime;
- проверены шесть интерфейсных областей: accessibility, layout, writing, typography,
  color и UI polish.

Ограничение ревью: локальный аккаунт не имел подключённого рабочего канала и наполненных
данных конкурентов. Поэтому empty/onboarding states проверены в браузере непосредственно,
а сложные наполненные состояния — по коду и тестам. Реальные provider outage, большая
команда, высокая нагрузка, WebKit/Firefox и screen reader остаются отдельными release gates.

## Карта зрелости

| Модуль | Что уже есть | Текущая зрелость | Главный blocker |
| --- | --- | --- | --- |
| Сегодня | Приоритетная лента, действия, refresh, done/snooze | Beta | Полезность зависит от неполных фоновых источников |
| Студия контента | AI-диалог, черновик, источники, восстановление, медиа | Beta+ | Chat scope — пользователь, а не проект/канал |
| Автопилот | Недельный план, quality gates, approval, repair, публикация | Beta+ | Нет полного production fault/load/E2E gate |
| Конкуренты и тренды | Разведка, досье, источники, три scope трендов | Beta | Качество/лимиты внешних источников и нет полной операционной модели |
| Карта возможностей | Ранжированные ходы с evidence и draft handoff | Alpha/Beta | Фоновый цикл зависит от уже созданной Growth-доски |
| Радар | Hybrid search, directory, web discovery, alerts | Backend Beta | Отдельный продуктовый экран отсутствует |
| Анализ сайта | Безопасный crawl, очередь, evidence, retry, export/compare | Beta | Capacity, cancel, quotas и production recovery не доказаны |
| Развитие | Недельные ходы, lifecycle, outcomes, handoff | Alpha/Beta | Новая доска создаётся синхронно при открытии; timezone захардкожен |
| База знаний | Sources, chunks, hybrid RAG, style/profile | Beta | Team/project semantics и AI provider recovery |

---

## 1. «Сегодня»

### Как работает сейчас

Экран собирает одну приоритетную ленту из нескольких read models:

- свежих возможностей;
- черновиков, требующих редакционного решения;
- результатов опубликованных материалов и метрик;
- сигналов, из которых строится pulse/состояние дня.

Сервер нормализует источники в карточки, ранжирует их, хранит пользовательские состояния
`done` и `snooze`, а при действии заново разрешает fingerprint карточки на сервере. Это
важно: клиент не может подменить контекст и создать произвольный черновик. Refresh
разделён по источникам и возвращает частичные статусы, поэтому недоступность одного
источника не обязана обрушать весь экран.

Фоновая свежесть сейчас неоднородна: статистика идёт через очередь, opportunity snapshots
материализуются каждые два часа, а «refresh reviews» фактически перечитывает БД и не
запускает отдельное обновление данных.

### Что уже хорошо

- один ясный ежедневный entry point вместо девяти разрозненных экранов;
- серверная проверка карточек и source provenance;
- частичный refresh и возможность безопасной деградации;
- состояния done/snooze и персональные предпочтения;
- действия ведут в реальный draft workflow, а не в декоративный CTA.

### Что нужно доработать

**P0 перед выпуском**

- формально определить freshness/SLO каждого источника и показывать пользователю
  `updated_at`, stale и unavailable отдельно;
- обеспечить фоновое создание Growth board, иначе блок возможностей может оставаться
  пустым до ручного посещения другого экрана;
- написать production E2E: пустой день, частичный отказ источника, stale snapshot,
  повтор действия, два таба, смена проекта и роли;
- проверить, что каждая карточка и mutation полностью project-scoped.

**P1 для качества продукта**

- объяснять, почему карточка первая: срочность, ожидаемый эффект, дедлайн и уверенность;
- добавить лимит внимания: 3–5 главных действий и progressive disclosure остальных;
- не называть перечитывание БД «обновлением», если upstream не пересчитан;
- дать пользователю настройку начала дня, timezone и quiet hours проекта;
- собирать outcome: открыл, создал draft, опубликовал, отклонил, эффект после публикации.

### Критерии product-ready и постоянной работы

- API availability 99,9%; p95 initial read до 800 мс без учёта первого холодного старта;
- свежесть статистики и трендов отображается явно, queue lag для двухчасового цикла
  не более 15 минут;
- повторный action с тем же fingerprint идемпотентен;
- алерты на пропавший источник, рост пустых лент, очередь старше SLO и ошибки создания
  draft;
- synthetic проверка каждые 5 минут: загрузка → refresh → безопасное действие тестовой
  карточки в изолированном tenant.

## 2. «Студия контента»

### Как работает сейчас

Студия — streaming AI workspace. Пользователь выбирает задачу/движок, ведёт диалог,
подтверждает brief, генерирует и редактирует материал, использует ссылки/контекст и может
передать результат в черновик. Генерация идёт через общий streaming endpoint. Сервер
хранит provenance и acknowledgement, а UI имеет recovery paths: повтор, предложение
доступной модели и аварийную локальную копию. Сессия диалога сохраняется на сервере.

Выявленная архитектурная проблема: `studio_chat_sessions` имеет первичный ключ по
`user_id`. Значит, история не изолирована по проекту, каналу или workspace. При
переключении проекта возможен неправильный контекст, даже если остальной draft flow
project-scoped.

На мобильной ширине подтверждён и исправлен horizontal overflow: длинное название
резервной AI-модели растягивало экран до 455 px при viewport 390 px. Recovery-banner
теперь складывается вертикально, а CTA переносит текст и занимает доступную ширину.

### Что уже хорошо

- streaming с понятным recovery, а не зависший spinner;
- явное подтверждение смены модели — выбор не меняется скрытно;
- сохранение серверной сессии и аварийной локальной копии;
- provenance и переход в реальный draft/editor flow;
- развитая работа с источниками и медиа.

### Что нужно доработать

**P0 перед выпуском**

- мигрировать chat session на `(project_id, channel_id, user_id)` или отдельный
  workspace/session id; определить правила общей командной истории;
- очищать/переключать контекст атомарно вместе со сменой проекта и канала;
- production E2E для streaming disconnect, provider timeout, quota, partial tokens,
  reload, два таба и повтор submit;
- запретить ложный success: материал считается сохранённым только после server ACK;
- провести security/privacy review всех промптов, источников и retention.

**P1 для качества продукта**

- разбить страницу на state machine и независимые компоненты: conversation, brief,
  generation, reference drawer, draft handoff;
- показывать стоимость, выбранного провайдера, ожидаемое время и причину fallback;
- добавить versions/diff и явное восстановление предыдущей генерации;
- измерять time-to-first-token, completion rate, retry success и draft conversion;
- унифицировать названия моделей: человеку важнее режим/качество, чем внутренний SKU.

### Критерии product-ready и постоянной работы

- p95 time-to-first-token до 3 секунд для здорового провайдера;
- отмена генерации действительно прекращает внешний запрос и биллинг;
- provider circuit breaker, лимиты на пользователя/проект и бюджетные алерты;
- ни один принятый ответ не теряется при reload/обрыве сети;
- session isolation тестируется на двух проектах, двух каналах и двух ролях;
- mobile 320/390, 200% zoom, keyboard-only и screen reader входят в CI matrix.

## 3. «Автопилот»

### Как работает сейчас

Автопилот строит недельный план из brief, настроек и candidate pool. Тяжёлая генерация
вынесена в отдельную очередь `autopilot-plans` и отдельный worker. Результат проходит
quality gates; частичный план можно repair-ить. Утверждение сделано двухшаговым: сначала
preview/confirmation, затем фактическое планирование. Публикация использует outbox и
reconciliation, что защищает от двойных side effects.

Есть недельный cron по воскресеньям в 21:00 по Москве и ручная генерация. Важный
эксплуатационный инвариант проекта уже задокументирован: обычный `npm run dev` обязан
поднимать полный worker, а в production нужен отдельный dedicated autopilot worker.

### Что уже хорошо

- тяжёлый AI-процесс отделён от web request;
- план, элементы, approval и публикация имеют отдельные состояния;
- quality gates и repair уменьшают вероятность принять неполный план;
- approval требует явного подтверждения;
- publication outbox/reconciliation ближе к production-подходу, чем прямой вызов API.

### Что нужно доработать

**P0 перед выпуском**

- доказать production topology: web, dedicated worker, Redis и PostgreSQL при рестартах,
  rolling deploy и сетевых разрывах;
- проверить lease/duplicate execution, kill worker в каждом шаге и replay одного job;
- ввести project budget, quota, concurrency и backpressure;
- зафиксировать versioned plan schema и совместимость старых незавершённых jobs после
  deploy;
- production E2E от brief до публикационного outbox с реальным rollback/reconciliation.

**P1 для качества продукта**

- объяснять каждую тему: какой сигнал, аудитория, цель и ожидаемый результат;
- позволить частично утвердить неделю, заблокировать день и перегенерировать один слот;
- добавить conflict detection с ручным календарём и часовыми поясами;
- показывать health worker/очереди человеческим языком, не техническим кодом;
- разрезать большую UI-страницу и worker на конечные state machines с contract tests.

### Критерии product-ready и постоянной работы

- 99,9% accepted jobs либо завершаются, либо переходят в видимый recoverable state;
- p95 ручного принятия job до 3 секунд, p95 queue start до 30 секунд при штатной нагрузке;
- ни одна публикация не создаётся дважды после timeout/retry;
- алерты на queue lag, stalled jobs, repair rate, reject rate, provider errors и budget;
- еженедельная synthetic-генерация в тестовом проекте и автоматическая проверка outbox;
- runbook: Redis outage, provider outage, stuck plan, bad deploy, массовая отмена.

## 4. «Конкуренты и тренды»

### Как работает сейчас

«Конкуренты» хранит отслеживаемые источники, досье, предложения соседей по нише и
собранные публикации. Для Telegram используется публичное чтение; Instagram опирается на
официальный Business Discovery. Recon запускается каждые два часа, discovery — ежедневно.

«Тренды» агрегирует сигналы по трём scope: ниша, интернет и глобальный режим, позволяет
выбрать период, вручную обновить данные и показывает статистику. Refresh оформлен как
операция с идемпотентностью. Интернет-режим использует результаты Radar, причём видимыми
становятся только проверенные источники.

### Что уже хорошо

- разведены tracked competitors, suggestions и trend signals;
- есть досье и источник/evidence, а не только AI-пересказ;
- фоновые интервалы recon/trend разнесены по времени;
- ручное обновление не обязано дублировать одну и ту же операцию;
- источник Instagram ограничен официальным API, без скрытого scraping.

### Что нужно доработать

**P0 перед выпуском**

- формализовать provider matrix: доступность, rate limit, legal basis, retention,
  стоимость и поведение при revoke;
- гарантировать project ownership/RBAC для всех tracked entities, suggestions и alerts;
- добавить cursor/pagination и нагрузочный тест для крупного проекта;
- в UI показывать source age, confidence, coverage gap и причину отсутствия данных;
- fault injection: 429, 403/revoked, изменённая HTML-разметка, timeout и partial batch.

**P1 для качества продукта**

- дедупликация одного сюжета между конкурентами и внешними источниками;
- separate «наблюдение» и «рекомендация»: факт не должен выглядеть как готовая стратегия;
- объяснимый trend score: рост, новизна, насыщенность, релевантность нише;
- отрицательная обратная связь «не мой конкурент/не мой тренд» должна влиять на ranking;
- cohort/outcome: какие сигналы реально превратились в успешный контент.

### Критерии product-ready и постоянной работы

- freshness recon до 2 ч 15 мин, daily discovery до 05:00 project timezone;
- provider-specific circuit breakers и квоты;
- alert при нулевом сборе там, где раньше был стабильный поток;
- provenance у 100% пользовательских утверждений;
- dashboard: coverage, duplicates, stale ratio, provider error rate, queue lag, cost/source.

## 5. «Карта возможностей»

### Как работает сейчас

Это не географическая карта, а ранжированный read model из Growth moves. Возможность
содержит evidence, объяснение, следующий шаг, срок жизни и source context. Из карточки
можно создать черновик с сохранением происхождения сигнала.

Snapshots материализуются каждые два часа, но глобальный materializer читает уже
существующие текущие Growth moves. Новую недельную Growth board он сам не создаёт.
Следовательно, пользователь, который не открыл «Развитие» и не запустил ручной refresh,
может не получить новые возможности автоматически. Это главный confirmed gap для
требования «работает постоянно».

Кроме того, качественная возможность обычно требует нескольких независимых signals.
В пустом или новом проекте продукт должен честно объяснять, каких данных не хватает.

### Что уже хорошо

- evidence и source context сохраняются до черновика;
- есть expiration, поэтому старые возможности не должны жить бесконечно;
- ranking отделён от UI;
- действие приводит к конкретному рабочему объекту.

### Что нужно доработать

**P0 перед выпуском**

- сделать недельный `ensureGrowthBoard` фоновым и идемпотентным для всех активных
  проектов до materialization opportunity snapshots;
- хранить статус зависимости: competitors/site/audience/brief unavailable, а не просто
  показывать пустой экран;
- project scope, race двух materializer’ов и повторное создание draft покрыть интеграцией;
- добавить stale/expiry reconciliation и алерт на проект без свежего snapshot;
- определить minimum evidence threshold и безопасный fallback для нового проекта.

**P1 для качества продукта**

- визуально группировать quick wins, strategic bets и expiring windows;
- показывать impact, confidence, effort и why-now;
- feedback «неактуально/уже сделано/неверный сигнал» возвращать в ranking;
- сравнивать opportunity с уже запланированным контентом, чтобы не предлагать дубль;
- переименовать «карту» или дать действительно обзорное пространство связей.

### Критерии product-ready и постоянной работы

- каждый активный проект получает новый weekly board и snapshot без посещения UI;
- p95 snapshot lag после upstream update до 15 минут;
- ни одна истёкшая opportunity не создаёт draft без явного предупреждения;
- мониторинг проектов без snapshot, stale ratio, evidence coverage и draft conversion;
- идемпотентный materialization/retry после DB или Redis outage.

## 6. «Радар»

### Как работает сейчас

Backend Radar сочетает локальный полнотекстовый поиск, каталог обнаруженных каналов,
web discovery и векторный индекс. Запуски поиска можно повторять/кешировать, результаты
проходят проверку, а для Telegram наружу выдаются валидированные `t.me`-источники. Есть
alerts и отдельные result actions.

Но пользовательский маршрут `/app/radar` сейчас просто перенаправляет на
`/app/trends?scope=internet`. Старый `radar-inner.tsx` существует, однако не является
активной самостоятельной поверхностью. Поэтому как отдельный пункт продукта «Радар»
сейчас не завершён: есть capability, но нет утверждённой IA и самостоятельного workflow.

### Что уже хорошо

- hybrid retrieval вместо одной внешней поисковой выдачи;
- верификация и нормализация результатов;
- cache/run model и alerts;
- интеграция с интернет-трендами.

### Что нужно доработать

**P0 — сначала продуктовое решение**

- выбрать один вариант: официально сделать Radar режимом «Трендов» и удалить дублирующий
  маршрут/legacy UI либо вернуть отдельный экран с уникальной задачей;
- если Radar отдельный: определить job-to-be-done — поиск новых источников, мониторинг
  темы или алертинг — и не смешивать три сценария на одном экране;
- привести runs/results/alerts к project scope и team RBAC;
- добавить quota, rate limits, provider/legal review и deletion/retention;
- production E2E с новым, кешированным, частичным и неуспешным поиском.

**P1 для качества продукта**

- объяснять, почему источник найден и почему ему можно доверять;
- merged result clusters и suppression дублей;
- preview до добавления в конкуренты/источники;
- saved searches, meaningful alerts и управление шумом;
- измерять precision пользовательской оценкой, не только число результатов.

### Критерии product-ready и постоянной работы

- один канонический URL и одно название capability по всему продукту;
- p95 кешированного поиска до 1 секунды, новый async run принимается до 3 секунд;
- provider outage возвращает последний проверенный кеш с явной давностью;
- alert delivery имеет idempotency, retry и audit trail;
- quality dashboard: zero-result rate, duplicate rate, verification failures, feedback.

## 7. «Анализ сайта»

### Как работает сейчас

Пользователь вводит домен и подтверждает право/разрешение на анализ. Сервер проверяет
соответствие домена, SSRF-риски и `robots.txt`. Crawl ограничен по страницам и объёму;
тяжёлая работа идёт через отдельную очередь и worker. У job есть lease, heartbeat,
revision и retry. Результат хранит structured evidence и формирует большой OSINT-отчёт;
есть export, retry и сравнение запусков.

Это хороший технический фундамент. Ограничение по смыслу: без Analytics/Search Console/
CRM модуль видит сайт и внешние признаки, но не знает реальную конверсию, доход и
поведение пользователей. Выводы нельзя подавать как доказанную бизнес-аналитику.

### Что уже хорошо

- explicit permission и защита от SSRF;
- bounded crawl, уважение robots и отдельная очередь;
- lease/heartbeat/revision снижают риск зависших и устаревших результатов;
- evidence, export, retry и compare;
- on-demand запуск не блокирует web request.

### Что нужно доработать

**P0 перед выпуском**

- добавить cancel и безопасную остановку активного crawl;
- per-project quotas, global concurrency, max wall time, memory/network budgets;
- очередь должна иметь видимые позиции/прогресс и ETA без ложной точности;
- fault injection: DNS rebinding, redirect в private IP, zip bomb/huge response, slowloris,
  worker kill, DB timeout и повтор job;
- privacy/legal retention для HTML, screenshots, exports и пользовательских доменов;
- load test и capacity plan: worker concurrency 1 сейчас не доказывает production SLA.

**P1 для качества продукта**

- разделить технические факты, эвристики и AI-рекомендации;
- приоритизировать исправления по impact/confidence/effort;
- интеграции с Search Console/Analytics только через явный OAuth и понятные permissions;
- incremental crawl и reuse неизменившихся страниц;
- командные комментарии/assignment и экспорт с неизменяемым snapshot id.

### Критерии product-ready и постоянной работы

- accepted job никогда не исчезает: terminal success, cancelled или recoverable failure;
- SLO по размерам: малый сайт p95, средний сайт p95 и отдельная политика для больших;
- private-network доступ блокируется на каждом redirect и DNS resolution;
- алерты на stalled lease, queue age, memory, crawl error ratio, repeated domain failures;
- еженедельный synthetic crawl контролируемого домена и проверка export/compare.

## 8. «Развитие»

### Как работает сейчас

Growth собирает сигналы из собственных публикаций, конкурентов, анализа сайта, вопросов
аудитории, brief и tracking. Из них ранжируются несколько типов growth moves. Ход имеет
lifecycle и outcome; его можно передать в «Студию» или «Автопилот».

`GET /api/growth` читает существующую доску, а `POST` синхронно вызывает
`ensureGrowthBoard`. UI делает этот POST при открытии. Отдельного недельного фонового
создания новой доски нет. Поэтому раздел не выполняет требование непрерывной работы без
действия пользователя и блокирует свежесть «Карты возможностей».

Ещё один confirmed product gap: `GROWTH_TIME_ZONE` жёстко равен `Europe/Moscow`, хотя в
других частях платформы существует project timezone.

### Что уже хорошо

- объединяет сигналы нескольких модулей в действия;
- ranking и provenance находятся в бизнес-слое;
- lifecycle/outcomes создают основу для обучения на результате;
- handoff в Studio/Autopilot закрывает следующий шаг.

### Что нужно доработать

**P0 перед выпуском**

- фоновая идемпотентная генерация weekly board для всех активных проектов;
- использовать timezone проекта, а не константу;
- project/team scope и permissions на чтение, создание, изменение state и outcome;
- versioned board: новая неделя не должна бесследно перезаписывать незавершённую старую;
- integration/fault tests для partial upstream data и двух одновременных генераций;
- убрать тяжёлое синхронное построение из request path или дать bounded async operation.

**P1 для качества продукта**

- показать цель, baseline, expected outcome, effort, owner и deadline для каждого move;
- разрешить принять, назначить, отложить, отклонить с причиной;
- feedback loop из реального outcome в следующий ranking;
- не генерировать псевдоточные обещания, когда данных мало;
- недельный review: что сделано, что сработало, что перенести.

### Критерии product-ready и постоянной работы

- новая versioned board готова к началу недели по timezone проекта;
- повтор генерации не создаёт дубль и не теряет ручные статусы;
- отсутствующий upstream виден как coverage gap;
- dashboard: board generation success, stale projects, accepted moves, completion, outcome;
- synthetic weekly cycle и recovery после остановки worker между расчётом и commit.

## 9. «База знаний»

### Как работает сейчас

База принимает вставленный текст, материалы канала и извлечённый профиль. Источник
разбивается на chunks, индексируется в `pgvector` и полнотекстовом индексе. RAG сочетает
semantic и lexical retrieval. Style/voice отделён от фактов, чтобы манера письма не
подменяла знания. Есть регулярное обновление профиля.

До этого ревью все три пути создания источника пытались поставить `knowledge-index` в
Redis и при ошибке оставляли строку `pending`. Комментарии обещали, что её подберёт
периодический цикл, но такого reconciliation не существовало. Источник мог зависнуть
навсегда.

Исправление в этом ревью:

- единый producer с детерминированным `jobId` на source;
- три попытки с backoff и безопасная повторная постановка;
- каждые пять минут DB→queue reconciliation всех pending sources;
- reconciliation также запускается при старте полного worker;
- отдельные regression tests на идемпотентную постановку и продолжение batch после
  ошибки Redis.

Живая проверка подтвердила зарегистрированный `knowledge-index` scheduler и повторный
подбор старого pending-source каждые пять минут. Embedding-движок отвечал
`ai_unavailable`, поэтому источник корректно остался pending для следующего цикла. Это
показывает, что Redis recovery работает, но дополнительно нужны provider circuit breaker,
ограничение возраста повторов и понятный пользовательский статус.

Вторая архитектурная проблема: UI читает channel knowledge, но построение AI-контекста
в `channelAiContextFor` фильтрует часть данных по `user_id`. В командном проекте участник
может видеть общую базу, но AI не обязательно использует источники, добавленные другим
участником. Семантику владения нужно унифицировать.

### Что уже хорошо

- факты и style/voice разделены;
- hybrid retrieval и векторный индекс;
- асинхронная индексация не держит request;
- состояние source позволяет показывать pending/ready/error;
- после текущего исправления Redis outage не превращает pending в потерянную работу.

### Что нужно доработать

**P0 перед выпуском**

- выбрать канонический scope: project + channel, определить права owner/editor/viewer;
- AI retrieval должен использовать тот же набор источников, который разрешён UI;
- внешний AI/embedding outage: circuit breaker, exponential backoff, max age и видимый
  recoverable error вместо вечного pending;
- deletion должна удалять chunks/vector/cache и фиксироваться в audit trail;
- prompt-injection/data-exfiltration review для загруженных источников;
- ограничения размера, форматов, квоты и cost budget на проект.

**P1 для качества продукта**

- показывать coverage, last indexed, размер и причину ошибки;
- reindex/replace/version source без создания неуправляемых дублей;
- citations из RAG должны открывать точный fragment исходника;
- quality eval set: точность фактов, конфликт источников, abstention и freshness;
- экспорт/удаление данных и прозрачная retention policy.

### Критерии product-ready и постоянной работы

- 99,9% созданных sources за ограниченное время переходят в ready или видимый error;
- pending age alert, queue lag alert, embedding provider error/budget dashboard;
- retry после Redis/provider outage без дублирования chunks;
- tenant isolation тесты на два проекта, два канала, две роли и двух авторов;
- RAG evals запускаются при смене модели, chunking или ranking.

---

## Общая программа доведения до продукта

### Фаза 0. Утвердить границы продукта

1. Решить судьбу Radar: отдельный продукт или режим Trends.
2. Утвердить каноническую модель `project → channels → members/roles → resources`.
3. Для каждого AI- и provider-пути описать данные, consent, retention, квоты и стоимость.
4. Оставить feature flag fail-closed до завершения gates.

### Фаза 1. Закрыть P0 корректности

1. Перенести Studio sessions и Knowledge retrieval на project/channel semantics.
2. Добавить background weekly Growth generation и затем Opportunity materialization.
3. Убрать Moscow timezone из Growth в пользу project timezone.
4. Провести mutation audit: permission, origin/CSRF, validation, idempotency, audit trail.
5. Унифицировать durable jobs: DB intent/outbox, deterministic identity, retry,
   reconciliation, quarantine и terminal state.

### Фаза 2. Эксплуатационная устойчивость

Для каждой цепочки `UI → API → DB → queue → worker → provider → DB → UI` нужны:

- correlation/operation id;
- метрики rate, errors, duration, saturation и queue age;
- structured logs без пользовательских секретов;
- provider circuit breaker и budget limit;
- readiness, heartbeat и external synthetic checks;
- documented runbook и безопасный rollback;
- backup restore rehearsal и data retention/deletion proof.

Минимальные общие цели:

- availability пользовательских read/mutation API 99,9%;
- p95 обычного read до 800 мс, acceptance async mutation до 3 секунд;
- 100% accepted async work имеет наблюдаемый terminal/recoverable state;
- отсутствие duplicate external side effects при retry;
- RPO/RTO утверждены и проверены восстановлением, а не только описаны.

### Фаза 3. Качество интерфейса

- WCAG 2.2 AA, keyboard-only, focus order, screen reader и 200% zoom;
- 320/390/768/1440 без overflow и скрытых основных действий;
- тексты различают факт, прогноз, AI-рекомендацию и недоступность данных;
- typography/line length и responsive hierarchy проверяются на наполненных данных;
- цвет не является единственным носителем состояния;
- motion поддерживает `prefers-reduced-motion` и не блокирует работу;
- один дизайн-язык loading, empty, stale, partial, error и retry во всех модулях.

### Фаза 4. Release gates

1. Полный unit/contract/integration suite на одном immutable SHA.
2. Production-topology E2E с web + всеми нужными workers + PostgreSQL + Redis.
3. Chromium, WebKit, Firefox; mobile keyboard; accessibility automation и ручной
   screen-reader smoke.
4. Fault injection: Redis/DB/provider outage, 429, timeout, slow response, worker kill,
   duplicate delivery и two-tab races.
5. Load/capacity profile для маленького, среднего и крупного проекта.
6. Security/privacy review, dependency audit и секреты.
7. Backup restore, deploy smoke, readiness и rollback smoke.
8. Canary release по модулям, а не одновременное включение всех девяти.

Рекомендуемый порядок canary:

1. «Сегодня» + «Студия контента»;
2. «База знаний»;
3. «Конкуренты и тренды»;
4. «Развитие» + «Карта возможностей»;
5. «Радар» после продуктового решения;
6. «Анализ сайта» с ограниченной квотой;
7. «Автопилот» последним, поскольку он создаёт наиболее рискованные внешние side effects.

## Что исправлено в рамках этого ревью

1. Исправлен mobile overflow в recovery-banner «Студии контента» и добавлен regression
   test.
2. Добавлен единый идемпотентный producer индексации «Базы знаний».
3. Добавлена DB→queue reconciliation pending sources каждые пять минут и при старте
   полного worker.
4. Добавлены regression tests для deterministic job identity и частичного Redis failure.

Эти изменения закрывают два конкретных дефекта, но не отменяют общий NO-GO: оставшиеся
P0 требуют отдельных миграций, продуктовых решений, provider permissions и полного
release cycle.

## Проверки этого рабочего среза

- `npm test`: 483 test files, 2544 tests — pass;
- `npm run lint` — pass;
- `npx tsc --noEmit` — pass для проверенного среза;
- `next build --webpack` в изолированном dist: 228 routes — pass;
- живой full runtime: health endpoint, PostgreSQL, Redis, stats worker и cron scheduler —
  доступны;
- 10 UI-маршрутов (девять пунктов плюс отдельный экран Trends) на 390 и 1280 px:
  horizontal overflow и duplicate IDs не найдены; поля «Анализа сайта», отмеченные
  первоначальной эвристикой, получили доступные имена через вложенные labels;
- мобильный recovery-banner Studio после исправления: `scrollWidth = clientWidth`;
- live worker подбирает старый pending knowledge source каждые пять минут и сохраняет
  recoverable pending при `ai_unavailable`.

Build также снова показал все experimental routes в production artifact. Runtime guard
остаётся fail-closed, но физическое исключение из bundle не выполнено.

## Финальное определение Done

Модуль считается готовым не тогда, когда happy path работает локально, а когда:

- его scope/permissions однозначны и проверены интеграционными тестами;
- любой retry безопасен, side effect идемпотентен, а потерянную очередь подбирает
  reconciliation;
- пользователь видит freshness, partial failure и способ восстановления;
- SLO измеряется внешним мониторингом;
- browser/accessibility/load/fault/security gates зелёные на том же SHA;
- существует runbook, backup/restore proof и rollback;
- canary не ухудшает error rate, latency, cost и ключевую пользовательскую метрику.

До выполнения этого определения скрытый experimental preview нужно сохранить.
