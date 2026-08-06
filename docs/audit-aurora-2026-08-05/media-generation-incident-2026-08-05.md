# «Аврора»: аудит отказа генерации изображения

Дата проверки: 5 августа 2026 года
Область: Студия контента → Картинки и видео → `nano-banana-2`
Режим: диагностика без исправления продуктового кода

## Краткий вывод

Два запроса «2 бомжа с бутылкой водки на мусорке» были корректно приняты сервером, сохранены, переданы worker и внешнему провайдеру. Провайдер создал две отдельные jobs, но обе завершил статусом `failed`. Очередь, база данных, worker, лимит и сохранение результата не были точкой отказа.

С высокой вероятностью провайдерский safety/moderation-классификатор отклонил уничижительную формулировку сцены. Это вывод из контролируемого сравнения, а не подтверждённый provider reason:

- исходная формулировка дважды завершилась `provider_failed`;
- нейтральный контроль на той же модели успешно завершился;
- уважительная переформулировка с сохранением ключевой семантики — два бездомных взрослых, контейнерная площадка и бутылка водки — также успешно завершилась;
- ранее на той же модели успешно создавались сцены с алкоголем, поэтому алкоголь сам по себе не объясняет отказ.

Точный moderation-код установить невозможно: адаптер при `status=failed` выбрасывает содержимое provider response и сохраняет только общий `provider_failed`. При повторной read-only проверке обе provider jobs уже отвечали `404 job_not_found`.

## Проверенная цепочка

| Этап | Фактический результат |
|---|---|
| UI | Запрос введён и появился в истории Студии |
| `POST /api/media/generations` | Запрос принят, создана отдельная generation row |
| Input validation | Prompt сохранён полностью и без подмены |
| Channel context | Использован Telegram-контекст того же канала; у сравниваемых запросов одинаковый объём brand profile |
| Queue | Handoff подтверждён |
| Worker | Generation переведена в `submitting`, затем `generating` |
| Provider create | Для обеих неудачных попыток получен provider job id |
| Provider poll | Получен terminal `failed` |
| Storage | Asset не создан, потому что provider не вернул файл |
| Quota | Оба резерва переведены в `released` |
| UI result | Показано общее «Модель не смогла создать файл» |

## Доказательства

### Исходные попытки

| Generation | Request id | Результат | Время | Asset | Quota |
|---|---|---|---:|---|---|
| 11 | `ba28c3a7-d54b-4dfa-9839-ba6de4e5dace` | `failed / provider_failed` | 21,7 с | нет | `released` |
| 12 | `3255244c-4190-4722-ae41-fd8057c5a4df` | `failed / provider_failed` | 13,9 с | нет | `released` |

Обе записи:

- модель: `nano-banana-2`;
- формат: `1:1`;
- качество: `medium`;
- стиль: `natural`;
- policy: `aurora-media-prompt v3`;
- `sourcePost`: отсутствует;
- `exactText`: отсутствует;
- prompt не заменён и не потерян.

### Контрольные запросы

| Generation | Request id | Запрос | Результат | Время |
|---|---|---|---|---:|
| 13 | `e60dfbc9-05fe-4e34-bbc4-6b46f5174324` | Нейтральная сцена с двумя взрослыми и бутылкой воды | `ready`, asset 12 | 34,2 с |
| 14 | `cad3af65-5ca8-4da4-a168-fbd751c730dc` | Уважительная сцена с двумя бездомными взрослыми, контейнерной площадкой и бутылкой водки | `ready`, asset 13 | 21,8 с |

Контрольные изображения не публиковались во внешние каналы.

### Сопутствующая readiness-плашка

Жёлтая плашка не была причиной отказа изображения: обе контрольные генерации успешно завершились при той же плашке.

Readiness отдельно сообщает:

- database: `up`;
- Redis: `up`;
- publication worker: `up`;
- schema: не применена миграция `20260805_release_a_trust_foundation.sql`;
- mail delivery: `not_configured`;
- AI health: `unobserved`.

Это самостоятельный release blocker, но не точка отказа media generation.

---

## AUR-MEDIA-P2-001 — Не объясняется контентное отклонение изображения

1. **Severity:** P2.
2. **Раздел:** Студия контента → Картинки и видео.
3. **Шаги:** выбрать `nano-banana-2`, отправить исходную формулировку, дождаться terminal state.
4. **Ожидание:** система различает временный технический сбой и отклонение содержания; объясняет, что именно нужно изменить, либо предлагает безопасную переформулировку с сохранением смысла.
5. **Фактически:** показывается общее «Модель не смогла создать файл. Измени описание и попробуй ещё раз».
6. **Доказательства:** generations 11 и 12, request ids выше; две одинаковые terminal failures; две успешные контрольные generation 13 и 14.
7. **Точка потери:** provider polling adapter при любом `failed/error/cancelled` заменяет provider payload общим `provider_failed`.
8. **Корневая причина:** отсутствует безопасная provider error taxonomy и UX для content/safety rejection.
9. **Риск:** пользователь не понимает причину, повторяет тот же запрос и считает генератор сломанным.
10. **Рекомендация:** извлекать и allowlist-сохранять безопасные `provider_error_code/category/retryable/trace_id`; для content rejection показывать понятную категорию и редактируемый вариант переформулировки.
11. **Regression test:** poll response с moderation/content error должен сохранять безопасную категорию, не раскрывать raw provider detail и показывать корректный UX.
12. **Уверенность:** высокая в точке потери; средне-высокая в конкретной moderation-причине, потому что провайдер не сохранил доступную детализацию.

Код:

- `src/lib/navy-media.mjs:145-151` — все provider terminal failures сворачиваются в один код;
- `worker/media-generation-worker.mjs:133-155` — общий код уходит в terminal failure;
- `worker.mjs:757-775` — в БД сохраняется уже обобщённая ошибка;
- `src/components/studio/media-generator.tsx:152-187` — UI показывает обобщённое сообщение.

---

## AUR-MEDIA-P2-002 — «Повторить генерацию» повторяет заведомо non-retryable запрос

1. **Severity:** P2.
2. **Раздел:** Студия контента → terminal media error.
3. **Шаги:** получить `provider_failed`, нажать «Повторить генерацию» без редактирования.
4. **Ожидание:** non-retryable content rejection не отправляется повторно без изменения; интерфейс предлагает «Изменить формулировку» или безопасный вариант.
5. **Фактически:** создаётся новый request key, новая generation row и новая provider job с тем же prompt.
6. **Доказательства:** generation 11 и 12 — два последовательных provider calls с одинаковым prompt и одинаковым terminal result.
7. **Точка подмены:** подмены данных нет; проблема в том, что terminal classification не управляет разрешённым recovery action.
8. **Корневая причина:** кнопка retry всегда вызывает `generate(generation)`, а после принятия предыдущей generation клиент очищает request key. Provider terminal reason не участвует в выборе действия.
9. **Риск:** лишнее ожидание, возможная стоимость внешнего provider job, повторяемая ошибка и потеря доверия.
10. **Рекомендация:** различать retryable/non-retryable; для неизменённого fingerprint с content rejection не создавать новый provider call; предложить редактируемую безопасную переформулировку. Не менять смысл молча.
11. **Regression test:** два нажатия с terminal non-retryable fingerprint не создают второй provider call; изменённый prompt создаёт новый fingerprint и может быть отправлен.
12. **Уверенность:** высокая.

Код:

- `src/components/studio/media-generator.tsx:302-353` — retry берёт те же prompt/settings и создаёт новый key;
- `src/components/studio/media-generator.tsx:407-410` — key очищается сразу после принятия server generation;
- `src/components/studio/media-generator.tsx:631-634` — любой failed result получает кнопку без проверки retryability.

---

## Пробелы тестового покрытия

Целевые тесты проходят: 4 test files, 22 tests.

Однако отсутствуют проверки:

- сохранения структурированной причины из terminal provider poll response;
- различения moderation rejection и технического provider failure;
- поведения кнопки retry для non-retryable результата;
- запрета второго provider call для неизменённого rejected fingerprint;
- UX с предложением переформулировки;
- быстрого исчезновения provider job и достаточности локального audit trail.

## Рекомендованный порядок исправления

1. Расширить server-side media error contract и безопасное хранение provider classification.
2. Добавить `retryable` и `category` в представление generation/API.
3. Изменить recovery UI: retry только для retryable; для content rejection — редактирование и предложенная переформулировка.
4. Добавить fingerprint fence для повторного non-retryable запроса.
5. Добавить server-side preflight/rewriter, который сохраняет смысл и требует подтверждения пользователя перед изменённым paid request.
6. Добавить regression и browser E2E tests.
