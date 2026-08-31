# Aurora: полный button-by-button QA и product review

Дата: 26 августа 2026  
Среда: локальный full runtime, PostgreSQL, Redis/BullMQ, Chromium; desktop и 390×844  
Аккаунт: отдельный QA-пользователь и проект 21

## Короткий вывод

Это была не только проверка исходников. Три независимых QA-агента и основной агент открывали реальные страницы, нажимали доступные кнопки, переключатели, вкладки, фильтры и формы, проверяли клавиатуру, focus restore, мобильную ширину, ошибки, reload и фоновые очереди.

Внешние публикации в настоящий Telegram-канал не выполнялись: пользователь не указал конкретный безопасный канал и текст, а отправка сообщения от его имени требует отдельного подтверждения. Production-like E2E был дважды запущен на отдельной БД, Redis DB 15 и фейковых AI/Telegram-провайдерах; production build/runtime поднимались, но Playwright дважды не завершил IPC-handshake с браузером за 180 секунд — сначала с bundled Chromium, затем с системным Google Chrome. Поэтому end-to-end browser publication **не засчитан**. Backend publication operation/lifecycle integration: 13/13 PASS; worker/outbox/lease/heartbeat/review targeted suite: 61/61 PASS.

Текущий общий вердикт: **NO-GO для широкого production-запуска**. «Анализ сайта» ближе всего к продукту; «Сегодня» и UI Базы знаний подходят для закрытой beta. Главные release blockers — смешивание контекста Studio, tenancy Базы знаний, зависимость «Развития» и «Карты возможностей» от посещения UI и отсутствие воспроизводимой worker-safe QA-среды.

## Что реально проверено

| Область | Реальные действия | Результат |
|---|---|---|
| Общая оболочка | sidebar groups, light/dark theme, notifications, Escape, focus restore | PASS после исправления Escape |
| Desktop/mobile | все девять областей, 390×844, overflow, labels, touch targets | в целом PASS; точечные P1/P2 ниже |
| «Сегодня» | empty/ready states, channel selector, refresh, partial success, sidebar/theme/notifications | PASS; refresh занял около 17 секунд |
| Studio | create menu, channel/model menus, settings quick/advanced, 14 секций, Escape/Tab trap, safe rewrite error | частичный PASS; AI success flow — через fake-provider E2E |
| Автопилот | empty/brief states, 9 рубрик, оба presets, selects, switches, fine settings, save/reload, plan dialog | PASS для локальных настроек; generation/approval — E2E |
| Конкуренты | форма, TG/Instagram, validation, error focus, cancel, mobile | частичный PASS; filled cards blocked фикстурой |
| Тренды | Feed/Statistics, 3 scopes, periods, source filters, thresholds, tabs/keyboard, 360 posts | PASS; найдены a11y-дефекты |
| Карта возможностей | empty/ready, CTA, mobile, static filled controls | частичный PASS; snapshot fixture отсутствовал |
| Radar | redirect/merged search state, no-channel validation, code/worker recovery review | standalone product фактически отсутствует |
| Анализ сайта | validation, ready report, 18 categories, 6 filters, 3 evidence cards, SEO/GEO tabs, history, 6 exports | PASS для готового отчёта |
| Развитие | empty/ready board, live region, trajectory/readiness/history, mobile | частичный PASS; реальные moves отсутствовали |
| База знаний | 3 modes, keyboard tabs, validation, labels, focus, mobile, source states | UI PASS после исправления; backend tenancy blocked |

## 1. «Сегодня»

### Как работает

Собирает readiness, свежесть источников, метрики, решения и следующий лучший шаг по выбранному каналу. Refresh синхронно ждёт фоновые BullMQ-задачи и возвращает full либо partial success.

### Прокликано

- no-channel CTA «Подключить канал»;
- переключение канала;
- «Обновить решения» с disabled/loading;
- partial-success и обновление времени;
- общие sidebar/theme/notifications controls;
- desktop/mobile empty и ready states.

Карточки `done/snooze/hide/undo` не были созданы имеющейся фикстурой; их обработчики и API изучены, но mutation-клики не выдаются за ручной PASS.

### Что доработать

- **P1:** refresh около 17 секунд выглядит зависшим; backend может ждать до 25 секунд.
- **P1:** нет browser E2E всех state/feedback/action/undo веток.
- **P2:** нет ETA, этапов выполнения и отмены.

### До состояния продукта

Перейти на operation model (`operationId`, queued/running/partial/done/error), polling/SSE, dedupe, timeout/retry; добавить deterministic fixtures, SLO очереди, freshness и alerting.

Вердикт: **закрытая beta**.

## 2. «Студия контента»

### Как работает

Чатовый контент-композер с выбором канала, модели, вида материала и подробного профиля публикации. Поддерживает streaming, retry/fallback, передачу результата в пост и durable chat session.

### Прокликано

- меню «Создать»: пост, недельный план, видео, опрос, лонгрид, картинка, reels, rewrite;
- safe error у «Перепиши последнее»;
- channel/model menus и Escape/focus restore;
- settings quick/advanced, selects и 14 раскрываемых секций;
- Tab trap и закрытие;
- mobile/desktop и contrast spot-check.

### Release blockers

- **P0:** история Studio хранится по `user_id`; project/channel/conversation identity отсутствует. История одного клиента/проекта может появиться в другом контексте.
- **P1:** browser E2E streaming/abort/fallback/retry/draft handoff недостаточен.
- **P2:** часть action-кнопок готового ответа имеет touch target 32 px.

### Исправлено в этом QA

- модальная панель настроек теперь объявлена `aria-modal=true`;
- существующий Tab trap/Escape/focus restore сохранены;
- regression test добавлен и проходит.

### До состояния продукта

Миграция на `project_id + channel_id + conversation_id`, backfill и RBAC; UI «Новый диалог»/история/архив; mock-provider browser E2E; circuit breaker, provider health, idempotency и журнал запросов.

Вердикт: **block release до изоляции истории**.

## 3. «Автопилот»

### Как работает

Хранит brief и quality profile, строит недельные планы через отдельную очередь, поддерживает pause/resume, preview/approval и перенос одобренных материалов в календарь. Weekly scheduler зарегистрирован на воскресенье 21:00.

### Прокликано

- empty/brief-missing states и переходы;
- center settings: edit, rubric, format, switches, dirty state, Cancel restore;
- отдельный brief: все 9 рубрик, оба presets, selects, disclaimer, fine settings, validation, save/reload;
- overview, paused state, metrics, schedule, plan parameters native dialog;
- ссылка возврата после исправления: один `<a>`, 44 px, без вложенной кнопки.

### Что доработать

- **P1:** две конкурирующие формы настроек (`/settings` и `/autopilot/brief`) меняют близкую модель разными словами и правилами.
- **P1:** «Включить автопилот» скрыто запускает платную AI-сборку без явного предупреждения о расходе лимита.
- **Operational P0 для QA:** одновременно работали production launchd worker и dev full worker. BullMQ не обязательно дублирует один job, но cron/reconciliation выполняются двумя контурами, делая side-effect QA недетерминированным.

### Исправлено

Устранена вложенность `<Link><Button>`: теперь это одна семантическая ссылка с button geometry. Browser: 44 px, nested buttons 0.

### До состояния продукта

Оставить один canonical settings flow; перед платной сборкой показывать явное действие и квоту; формализовать одну worker topology на environment; добавить release E2E build→plan→approval→calendar→publish→retry.

Вердикт: **технически зрелый, но NO-GO без provider/publish E2E и контролируемой worker topology**.

## 4. «Конкуренты и тренды»

### Как работает

«Конкуренты» хранит отслеживаемые источники, синхронизирует посты/метрики вручную и cron-задачами. «Тренды» объединяет собственную нишу, Internet search и глобальную коллекцию, показывает feed/statistics и создаёт публикацию из найденного материала.

### Прокликано

- competitor add form, TG/Instagram, validation и network-specific copy;
- Trends Feed/Statistics, scopes Niche/Internet/Global, все periods и source filters;
- keyboard tabs/roving tabindex;
- global collection: 12 источников, 360 постов, expand/collapse, четыре threshold;
- mobile 390×844 без overflow.

### Что доработать

- **P1:** competitor list превращает DB error в `200 []`, скрывая outage под empty state.
- **P1:** list project/channel-scoped, а detail/PATCH/DELETE всё ещё `user_id`-scoped; collaborator видит карточку, но получает 404 на действие.
- **P1:** manual refresh и cron могут синхронизировать один источник одновременно без lease.
- **P1:** Cancel формы не возвращает фокус opener; форма активна без канала.
- **P1 a11y, исправлено:** 7 image-only links в Trends были без accessible name.
- **P1 a11y, исправлено:** invalid Internet query не переводил фокус в input.
- **P2:** два loader не учитывают reduced motion.

### До состояния продукта

Единый `requireSelectedProjectPermission`; DB lease/heartbeat/stale reclaim; last-good snapshot отдельно от last-attempt; 429 circuit/backoff; alerts по stale age; behavioral browser E2E. Accessible names/focus recovery исправлены и перепроверены: 7/7 image links именованы, invalid query возвращает фокус и `aria-invalid=true`.

Вердикт: **Trends — beta; Competitors — block release для командного режима**.

## 5. «Карта возможностей»

### Как работает

Материализует immutable opportunity snapshots из growth moves и конкурентных/трендовых сигналов, отображает list/matrix и создаёт draft с deterministic client key.

### Прокликано

- no-channel и ready-zero states;
- «Добавить конкурентов»;
- «Обновить карту» availability;
- mobile layout и статический inventory list/matrix/card/evidence/draft.

### Release blockers

- **P0:** background materializer читает только уже существующие `growth_moves`; если пользователь не открыл «Развитие», cron может постоянно успешно обрабатывать ноль данных.
- **P1:** refresh активен без prerequisites и делает бесполезную mutation при нуле конкурентов.
- **P1:** почти отсутствует behavioral coverage наполненной матрицы и draft flow.

### До состояния продукта

Scheduled system Growth refresh должен предшествовать snapshot materialization; нужен единый durable pipeline, readiness API, watermark/retry/backoff/stale alerts и E2E fresh/stale/insufficient-data.

Вердикт: **block production**.

## 6. «Радар»

### Как работает сейчас

Отдельный `/app/radar` восстановлен в production-навигации и снова отображает standalone UI с tabs Channels/Posts/Trends, добавлением конкурента и сохранением идеи. Старый production redirect удалён.

### Что проверено

- redirect и no-channel recovery;
- cached fixture существовала, но fake channel был деактивирован реальным reconciliation worker;
- API/worker claim, cache и recovery изучены.

### Что доработать

- **P1:** worker переводит run `queued→running`, но после падения redelivery не reclaim-ит `running`; run может зависнуть навсегда.
- **P1:** run/result/cache/action scoped по `user_id`, хотя канал — project resource; участники повторяют платный поиск и не делят результаты.
- **Исправлено:** standalone Radar был скрыт redirect-ом; отдельный экран и пункт меню восстановлены.

### До состояния продукта

Зафиксировать отдельный Radar как каноническое IA-решение. Добавить lease token/heartbeat/stale sweeper/DLQ, project-scoped cache, cancel/retry/quota/freshness и worker-safe seeded E2E.

Вердикт: **NO-GO до решения продукта и recovery worker**.

## 7. «Анализ сайта»

### Как работает

Создаёт revisioned analysis request, проверяет domain consent/SSRF/robots/quota, запускает очередь с deterministic job ID, heartbeat/lease и сохраняет версионный snapshot с экспортами.

### Прокликано

- empty native validation и URL normalization;
- mismatch URL/domain с 422 и request id;
- ready report после reload/history;
- все 18 category options и 6 filters;
- все 3 evidence cards;
- SEO/GEO мышью и ArrowRight/Home/End;
- CSV/XLSX/JSON/PDF/HTML/Markdown exports;
- mobile и contrast.

### Что доработать

- **P1:** API validation error остаётся page-level; нет `aria-invalid`, field-linked error и focus recovery для domain/consent.
- **P1:** browser E2E failed/retry/poll/reload/corrupted snapshot.
- **P2/product:** scheduled re-analysis, diff notification, freshness badge и retention policy.

### До состояния продукта

Field error mapping + focus; weekly/monthly re-analysis с renewed consent/policy snapshot; queue latency/error SLO, autoscaling по crawl/provider quotas и alerting.

Вердикт: **самый зрелый модуль; близок к production после P1 recovery work**.

## 8. «Развитие»

### Как работает

Строит недельную Growth-board с primary/secondary moves, evidence и outcome lifecycle. Сейчас `ensureGrowthBoard` вызывается mutation-запросом при открытии UI.

### Прокликано

- no-channel/ready board;
- trajectory, empty goal, moves 0/0, readiness CTA, history, learning state;
- live region и mobile layout;
- control inventory для primary/secondary/evidence/skip/outcome.

### Release blockers

- **P0:** доска не создаётся постоянно без посещения страницы; worker cron не вызывает system-scoped `ensureGrowthBoard`.
- **P1:** timezone жёстко `Europe/Moscow`, хотя проект поддерживает свою timezone.
- **P1:** «Не актуально» сразу и необратимо ставит `skipped`; undo/reopen отсутствует.
- **P1:** tests в основном source contracts, а не interactions.

### До состояния продукта

`ensureAllGrowthBoards` в system worker; запуск по timezone проекта и watermarks сигналов; health row; undo/reopen; component/browser lifecycle tests.

Вердикт: **block production**.

## 9. «База знаний»

### Как работает

Принимает pasted text, structured profile и публичные посты канала; сохраняет source в pending и индексирует chunks/embeddings через очередь. AI context затем выбирает знания для генерации.

### Прокликано

- empty/effective profile/counters/source list;
- Paste/Form/Read-channel tabs мышью и клавиатурой;
- empty validation, focus, inline errors;
- mobile 390×844 после исправления;
- labels для шести fields;
- pending/error/ready states и API contracts.

### Исправлено

- общий mobile overflow устранён; tablist скроллится отдельно;
- labels связаны с controls;
- empty submit ставит `aria-invalid`, `aria-describedby`, inline alert и фокусирует первое invalid field;
- регрессионные tests проходят;
- indexing enqueue получил deterministic helper и периодическую DB→queue сверку для pending sources.

### Release blocker

- **P0 для команд:** GET показывает источники всего channel, POST записывает actor `user_id`, DELETE удаляет только actor-owned source, AI context читает только actor-owned knowledge. Коллега видит источник, не может удалить и его AI не использует эти знания.

### До состояния продукта

Source должен быть project/channel-owned с `created_by_user_id`; единая role policy list/create/delete/context; двухпользовательский tenant test; soft delete/restore; explicit indexing state machine, retry/DLQ/watchdog/metrics.

Вердикт: **UI прошёл; backend team mode — block release**.

## Сквозные находки

### Исправлено и проверено

1. Notifications: явный Escape fallback; browser PASS, dialog закрылся, фокус вернулся trigger.
2. Studio settings: `aria-modal=true`; regression PASS.
3. Autopilot brief: одна link-action вместо `<a><button>`; browser height 44 px, nested buttons 0.
4. Knowledge: mobile overflow, labels и error focus; browser 390×844 и tests PASS.
5. Trends: image-only links получили accessible name, invalid search возвращает focus; browser и tests PASS.

### Operational

Локально одновременно работали `ru.aurora.publication-worker` под launchd и dev full worker. Остановка launchd-сервиса была отклонена как риск для реальных публикаций — правильно. Product-ready QA требует изолированный environment/tenant и mock provider, а не фиктивный канал в общей runtime БД.

### Test evidence

- Today/Studio/Knowledge slice: 12 files / 58 tests PASS.
- Autopilot/Growth/Opportunities slice: 18 files / 102 tests PASS; colors 5/5.
- Competitors/Trends/Radar/Site slice: 29 files / 140 tests PASS.
- Дополнительные исправления: notifications 9 tests, Studio settings 33 tests, Autopilot link 1 test — PASS.
- Publication DB integration: operation 5/5, lifecycle 8/8 — PASS на отдельной `aurora_publication_gate_test`.
- Publication worker/outbox/lease/heartbeat/review: 14 files / 61 tests — PASS.
- `test:e2e:real`: FAIL до начала browser journey из-за `browserType.launch` timeout 180000 ms на двух Chromium binaries; это открытый release-gate blocker.
- Это перекрывающиеся targeted suites, поэтому числа нельзя складывать как число уникальных тестов.

## Приоритетный roadmap

### P0 — до production

1. Studio conversation tenancy/context migration.
2. Knowledge project/channel ownership и единый RBAC/AI context.
3. Scheduled system Growth generation независимо от UI.
4. Opportunity materialization после гарантированного Growth refresh.
5. Изолированная release E2E-среда с единственной worker topology и fake providers.

### P1 — следующий слой

1. Competitor project scoping, DB error transparency и sync leases.
2. Radar lease/reclaim/DLQ и project-scoped cache.
3. Один canonical Autopilot settings flow и явная AI/quota mutation.
4. Today async operation UX.
5. Field-level focus/error recovery в Trends/Site/Competitors.
6. Behavioral browser tests наполненных states и race/reload/retry/undo.

### Для постоянной работы

Каждый background product должен иметь: deterministic job identity, DB lease/heartbeat, stale reclaim, bounded retries, DLQ/terminal state, idempotent writes, source watermark, last-attempt/last-success, queue latency/error/freshness metrics, alerts и manual safe retry. Без этого «работает по cron» ещё не означает «работает постоянно».
