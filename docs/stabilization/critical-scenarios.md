# Карта критических сценариев

Дата ревизии: 2026-08-26. Статусы: **AUTO** — есть автоматическое доказательство;
**MANUAL** — выполнен локальный браузерный прогон; **GAP** — аргументированное исключение,
которое блокирует release или требует отдельного rehearsal.

В каждой строке последовательность одна: happy path; отказ; восстановление → ожидаемый
результат. Имена тестов приведены как проверяемое доказательство, а не как замена
production rehearsal.

## Аккаунт

| Сценарий | Поведение и восстановление | Доказательство |
| --- | --- | --- |
| Регистрация | Валидные данные создают пользователя и личный проект; duplicate/invalid input отклоняется; повтор с исправленными данными → один аккаунт и onboarding. | **AUTO:** `registration.integration.ts`, `password-registration.test.ts`, register route tests. |
| Вход | Верный пароль создаёт session с credential epoch; неверный пароль или stale epoch не авторизует; повторный вход → новый валидный session. | **AUTO:** login route, `session.test.ts`; **MANUAL:** вход незавершённого пользователя открыл onboarding. |
| Выход | Logout инвалидирует текущий session и очищает cookie; повторный запрос становится unauthorized; вход восстанавливает доступ. | **AUTO:** auth/session route tests. |
| Восстановление пароля | Одноразовый token меняет пароль один раз; expired/used/racing token отклоняется; новый запрос → новая одноразовая ссылка. | **AUTO:** `password-recovery.integration.ts`, password-reset tests. |
| Смена пароля | Reset-path атомарно меняет hash и epoch; конфликт не оставляет частичного состояния; вход новым паролем → доступ восстановлен. | **PARTIAL/GAP:** серверная гарантия покрыта, отдельного authenticated «сменить пароль» UI нет. |
| Истечение сессии | Истёкшая или epoch-stale session не принимается; интерфейс возвращает на login; вход → новая session. | **AUTO:** `session.test.ts`, password recovery integration. |
| Отзыв всех сессий | Смена пароля увеличивает credential epoch и отзывает все старые sessions; старые cookies остаются недействительными. | **AUTO:** password reset unit/integration; **GAP:** нет отдельного пользовательского действия «выйти на всех устройствах». |
| Повторный вход после смены | Старый пароль и sessions отклонены; новый пароль создаёт session на новом epoch → пользователь входит без восстановления старых sessions. | **AUTO:** `password-recovery.integration.ts`. |

## Проект

| Сценарий | Поведение и восстановление | Доказательство |
| --- | --- | --- |
| Создание | Транзакция создаёт project, owner membership и audit identity; ошибка откатывает всё; повтор → новый проект только по явному действию. | **AUTO:** `project-collaboration.integration.ts`, projects route tests. |
| Выбор текущего | Сервер принимает только active membership; чужой ID отклоняется; пользователь выбирает доступный проект → контекст обновлён. | **AUTO:** `project-context.test.ts`, project client/route tests. |
| Переключение | Все последующие reads получают project из server-owned preference; потерянное membership запрещает switch; выбор доступного проекта → данные не смешиваются. | **AUTO:** project context/permissions and switcher tests. |
| Приглашение | Owner создаёт hashed single-use invitation с TTL; expired/used token отклоняется; новое приглашение → участник добавлен один раз. | **AUTO:** collaboration integration and invitation tests. |
| Изменение роли | Разрешённый actor меняет роль под lock; forbidden/stale request не меняет данные; повтор после refresh → актуальная роль. | **AUTO:** project team tests and concurrent owner-demotion integration. |
| Удаление участника | Permission и last-owner invariant проверяются транзакционно; запрещённое удаление не меняет membership; owner исправляет роли и повторяет. | **AUTO:** project team/route tests. |
| Архивирование проекта | Архивный флаг учитывается всеми server context queries; пользовательского mutation/API и recovery-flow нет. | **GAP/P1:** release блокируется до реализации или формального удаления сценария из scope. |
| Потеря доступа к открытому проекту | Каждый read/write повторно проверяет active membership; открытая вкладка получает access denied, не данные; выбор доступного проекта/login → безопасное восстановление. | **AUTO:** permissions, drafts, editorial, publication authorization tests. |

## Telegram

| Сценарий | Поведение и восстановление | Доказательство |
| --- | --- | --- |
| Подключение бота | Handle проверяется сервером и сохраняется идемпотентно; malformed/taken channel отклоняется; исправить права/handle и повторить → один channel. | **AUTO:** channel routes and onboarding service; **MANUAL:** шаг подключения и reload recovery. |
| Проверка прав | Активным становится только канал с доказанной readiness; missing permission fail-closed; добавить бота администратором и повторить. | **AUTO:** provider capability and channel-health tests. |
| Выбор канала | Только active Telegram channel текущего проекта принимается; чужой/inactive ID отклоняется; выбрать доступный → destination сохранён. | **AUTO:** server draft and onboarding progress tests. |
| Потеря прав или удаление бота | Health/readiness блокирует отправку и не сообщает успех; вернуть права и повторно проверить → дальнейшие операции разрешены. | **AUTO:** Telegram channel health, safe-error and publication safety tests. |
| Истечение/замена токена | Пользовательский token не входит в stable модель: используется централизованный bot secret; неверная конфигурация fail-closed. | **GAP/OPS:** rotation/recovery требует staging secret-rotation rehearsal. |
| Временная недоступность | Retryable outage/rate limit получает bounded retry/backoff; terminal error не повторяется; после readiness retry/reconciliation → один результат. | **AUTO:** worker Telegram update-retry, reconciliation, safe-error tests. |
| Длинный/медиа/частичный материал | Payload разбивается детерминированно, части и provider IDs связаны; partial/unknown не становится confirmed; reconciliation или ручное решение. | **AUTO:** Telegram payload, multipart and carousel worker tests. |

## Контент и редактор

| Сценарий | Поведение и восстановление | Доказательство |
| --- | --- | --- |
| Создание и ручное сохранение | Client key создаёт один draft; invalid destination/media fail-closed; исправить поля и повторить → server ACK. | **AUTO:** draft client/server/route tests; **MANUAL:** первый материал открыл exact draft. |
| Autosave и параллельные запросы | Single-flight и revision допускают один актуальный save; старый ACK не очищает новую revision; следующая локальная правка → новый save. | **AUTO:** `draft-client.test.ts`, `draft-outbox.test.ts`. |
| Reload | Server snapshot и account/project-scoped outbox восстанавливают последнюю подтверждённую или pending revision; повреждённая cache не подменяет server state. | **AUTO:** outbox/client tests; **MANUAL:** onboarding reload и composer reopen. |
| Другая вкладка и конфликт | Version mismatch возвращает current server draft; stale tab не перезаписывает; refresh/явное recovery → пользователь выбирает актуальную версию. | **AUTO:** server draft conflict tests and composer protection contracts. |
| Offline → online | Полная pending revision остаётся локально до ACK; cleanup failure не означает потерю; reconnect/new revision → синхронизация. | **AUTO:** outbox/autosave tests; **GAP:** текущий production-topology browser fault injection не завершён. |
| Удаление | Versioned DELETE удаляет только после ACK; rejection оставляет local/server draft; refresh и повтор → точный результат. | **AUTO:** draft client/server and route tests. |
| Восстановление | Recovery создаёт отдельный manual draft и сохраняет источник; replay возвращает ту же запись; конфликт требует явной ответственности. | **AUTO:** server draft and recover route tests. |
| Форматирование и ссылки | Строгие rich-text ranges сохраняются; unsafe ranges/URLs отклоняются; исправление → форматированный payload без потери. | **AUTO:** server-drafts and Telegram payload tests. |
| Медиа | Только project-owned assets и допустимые комбинации; чужой/невалидный asset отклоняется до записи; выбрать валидный asset → draft сохраняется. | **AUTO:** server draft, media and Telegram carousel tests. |
| Длинный текст и Unicode | Лимиты валидируются, Unicode/surrogate/combining sequences не режутся; Telegram chunking использует безопасные границы. | **AUTO:** draft input and Telegram payload tests. |
| HTML-like content | Пользовательский текст рендерится как text и Telegram-safe HTML, script не исполняется; malformed formatting отклоняется. | **AUTO:** payload/formatting tests; **MANUAL:** `<script>`-подобный фрагмент показан как текст без dialog/console error. |
| Мобильный редактор | На 320/390/768 action bar находится в потоке и не закрывает textarea; desktop сохраняет fixed action surface; focus clearance действует на desktop. | **AUTO:** composer UX contract; **MANUAL:** четыре viewport без horizontal overflow. Keyboard+open-keyboard остаётся gate gap. |
| Retry первого материала | Idempotent replay обновляет только untouched version 1 через CAS; изменённый в редакторе draft не перезаписывается, требуется явный выбор server version. | **AUTO:** onboarding replay tests; **MANUAL:** один draft, version 2, последний текст. |

## Публикация

| Сценарий | Поведение и восстановление | Доказательство |
| --- | --- | --- |
| Добавить в календарь / сейчас / очередь | До enqueue создаётся operation с idempotency key; double click/replay возвращает ту же operation; UI показывает только server outcome. | **AUTO:** publication operation tests/integration and composer single-flight. |
| Перенести | Schedule revision fencing делает старую delayed job inert; конфликт не меняет актуальную дату; refresh и повтор с новой version. | **AUTO:** publication lifecycle integration and draft schedule tests. |
| Отменить | Cancel до provider call fence-ит job/lease; после начала delivery возвращает in-progress, не ложный успех; дождаться результата/reconciliation. | **AUTO:** publication lifecycle integration. |
| Повторить после ошибки | Retry разрешён только для безопасного terminal/retryable состояния; unknown автоматически не повторяется; manual retry создаёт прослеживаемое действие. | **AUTO:** publication retry, safety and extra-operation tests. |
| Provider timeout/потерянный ответ | После возможной отправки status становится unknown/provider_pending, не confirmed и не auto-retry; reconciliation или человек → один финал. | **AUTO:** publication safety/state and Telegram reconciliation tests. |
| Успех после restart worker | Persisted queue/operation восстанавливается; pre-provider lease может быть reclaimed, возможная отправка quarantined/unknown; restart reconciliation завершает один раз. | **AUTO:** publication operation/lifecycle integrations, graceful shutdown and lease tests. |
| Несколько workers | DB lease, deterministic job ID и unique constraints линеаризуют claim; проигравший worker не вызывает provider. | **AUTO:** publication lease/heartbeat/safety tests and PostgreSQL integrations. |
| Защита от дублей | Client single-flight — только UX; DB operation key, queue job ID, part identity и provider IDs являются защитой; replay не создаёт вторую отправку. | **AUTO:** publication idempotency/outbox/operation and multipart tests. |
| Quarantine | Overdue/неоднозначная operation переводится в quarantined без раннего retry; ручное восстановление создаёт один editable draft. | **AUTO:** quarantine integration: 4 overdue, 1 future, 0 duplicates; lifecycle restore test. |
| История | Каждое создание, transition, provider ID, error и review action связано с operation/project; unauthorized read запрещён. | **AUTO:** operation routes/services and project authorization tests. |

## Согласование

| Сценарий | Поведение и восстановление | Доказательство |
| --- | --- | --- |
| Отправка версии | Submit фиксирует exact draft/workflow version и immutable hash; stale submit отклоняется; refresh и submit актуальной версии. | **AUTO:** editorial approval and route tests. |
| Комментарий | Именованный комментарий сохраняется в project journal; чужой проект запрещён; вернуть membership/выбрать проект и повторить. | **AUTO:** editorial approval/route tests. |
| Одобрение | Только approver решает открытую exact request; forbidden/stale decision не меняет state; актуальный approver повторяет. | **AUTO:** approval race/permission tests. |
| Отклонение/правки | Changes requested остаётся видимым и связывается с revision; исправленная версия создаёт новый цикл, не переписывает решение. | **AUTO:** editorial approval tests and review panel contracts. |
| Изменение после одобрения | Любая смысловая/tracking правка увеличивает revision и инвалидирует старый ACK; новое согласование → publishable version. | **AUTO:** editorial and server draft no-op/revision tests. |
| Публикация старой версии | Publication проверяет exact approved lineage/version; stale approval блокируется до queue/provider side effect; согласовать актуальную версию. | **AUTO:** collaboration integration and approved lineage tests. |
| Одновременные решения | Row lock/conditional update позволяет ровно одному решению; второй actor получает conflict/no-op, затем видит финальный journal. | **AUTO:** editorial concurrent decision test. |
