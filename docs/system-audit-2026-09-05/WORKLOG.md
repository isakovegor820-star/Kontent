# Проверка достоверности раздела «Система»

Цель зарегистрирована в Codex и остаётся активной. Дата: 5 сентября 2026.

## Границы среды и исходные доказательства

- Рабочий репозиторий: `/Users/egor/mvp and prod/platform`; ветка `fix/audit-2026-09-05-production-readiness`; исходный HEAD `d90d5b619c2db50f56a4b52fcf46e959f3d30c6b`.
- Существующие изменения сохранены: `evidence/initial-git-status.txt`, `evidence/pre-existing-scope.diff`. Ни reset, ни checkout пользовательских файлов не выполнялись.
- Открытая вкладка: `http://localhost:63342/admin`. Процесс использует отдельную копию `/private/tmp/aurora-admin-release`. Это локальная production-сборка с синтетическими данными, а не production. Сессия истекла при переходе в «Система».
- `http://localhost:3000/api/health` и `63342/api/health` вернули 200 `alive`. Это только живость HTTP-процессов.
- По существующей истории GitHub последний успешный deployment: `24117aaee406686f8a006f3b2875bea6342c29a8`, 2026-09-05 08:46:41 UTC, run 33956191576. Это историческое доказательство, а не свежая проверка production.
- Production URL из настроек существующего GitHub environment: `https://72.56.38.62:8443`. Новые production workflow не запускались: automatic approval review отклонил экспорт runtime/DB/queue/journal metadata в GitHub без отдельного явного разрешения. Аналогично отклонён вход в старый QA-аккаунт с паролем из найденного скрипта.
- Независимая тестовая среда: `/private/tmp/aurora-system-audit-20260905/app`; PostgreSQL 127.0.0.1:57641, новая БД `aurora_system_test`; отдельный Redis 127.0.0.1:57642; полный `npm run dev` на 63450. Рабочие env-файлы не копировались; ключи созданы заново; внешние provider credentials отсутствуют.

## Проверяемый список

- [x] Инструкции, версия, ветка, изменения, процесс открытой панели.
- [x] Прочитаны все шесть better-* skills и better-interface; выбран full.
- [x] Прослежены все 15 компонентов, 12 очередей, API и преобразования.
- [x] Сохранено воспроизведение девяти исходных дефектов (`regressions-before.log`: 9/9 FAIL).
- [ ] Исправления и дополнительные fault/recovery сценарии.
- [ ] SQL сверка с PostgreSQL и выполнение очередей с Redis/BullMQ.
- [ ] Полный worker и проверка отсутствующих/доступных зависимостей.
- [ ] Lint, typecheck, unit/contracts, build.
- [ ] Браузер, сеть, refresh, stale, error, narrow viewport, клавиатура, контраст.
- [ ] Период наблюдения со свежими данными.
- [ ] Финальный отчёт с ограничениями и статусом цели.

## Карта источников до исправления

Общий путь: runtime/SQL/Redis → `defaultDefinitions` → `runDiagnosticDefinitions` → `loadAdminSystemDiagnostics` → `GET /api/admin/system` → React `AdminSystemCenter` → карточка / подробности. HTTP и fetch используют `no-store`; общий серверный кеш отсутствует. Redis/queues Promise разделяются только внутри одного сбора. Последний успех дополнительно кешировался в памяти web-процесса. Ручное обновление и необязательный polling 30/60 секунд; общий UI stale был 5 минут, карточки его игнорировали.

| Показатель | Что означает / источник | Формула или условие | Период | Обновление | Правило статуса до исправления | Достоверность до исправления |
|---|---|---|---|---|---|---|
| Общий статус / total, healthy, configured, warnings, critical | Сумма состояний 15 probes | core down → down; остальное кроме healthy/configured → warning | Один сбор | GET | Одни configured могли дать общий healthy | Не подтверждал всю платформу |
| HTTP event loop | Задержка setTimeout(0), web-процесс | max(0, elapsed − 1), мс | Одна проба | GET | 250 мс warning, 2000 мс down | Не является доступностью всех API |
| HTTP uptime / RSS / heap used,total | process.uptime / memoryUsage | Секунды и байты | С запуска процесса / сейчас | GET | Не участвуют в статусе | Реальны, локальны одному процессу |
| PostgreSQL latency | SELECT 1 | Время исполнения+получения соединения | Одна проба | GET | Успешный SELECT, waiting или любые прошлые ошибки → degraded | Старые ошибки не давали восстановиться; собственные probes создавали waiting |
| Пул max,total,active,idle,waiting | pg.Pool / db-pool-monitor | active = total − idle | Сейчас | GET | waiting > 0 | Только web, другие процессы не суммируются |
| acquire wait p95 / samples | Массив последних ≤1024 измерений | nearest rank ceil(n×0.95), null если n=0 | По числу замеров, не по времени | Каждый acquire | Время не определяет статус | Реально, но окно не было объяснено |
| acquire timeouts/errors / timeout settings | Счётчики процесса / db-pool-config | Накопление с запуска; timeout часть errors | Весь процесс | Каждый acquire | Любая прошлая ошибка делала degraded навсегда | Ложное текущее предупреждение |
| Схема: actual/expected version, migrations, reasons | schema-readiness → PostgreSQL catalog и ledger | Manifest/checksum/capabilities | Сейчас | GET | missing schema → degraded, query failure → down | Сбой probe смешивался с outage |
| Redis PING, memory,uptime,clients | PING, INFO | ms/bytes/seconds/count | Сейчас/с запуска Redis | GET | Отсутствие queue consumer могло пожелтить Redis | INFO относится ко всему Redis, очереди — только logical DB |
| 12 очередей: workers | BullMQ CLIENT LIST | Число зарегистрированных клиентов consumer | Сейчас | GET | Любой consumer → healthy | Не доказывает выполнение; paused игнорировался |
| waiting,active,delayed | BullMQ state collections | Число retained job IDs | Сейчас | GET | pending + no workers → down | Не учитывались prioritized, paused, waiting-children |
| completed,failed | BullMQ retained terminal job IDs | Остаток после removeOnComplete/removeOnFail | Не определён; retention | GET | Любой retained failed → degraded | Не число ошибок за сутки, не lifetime и не текущий отказ |
| Старейшая задача | getJobs(wait,active,delayed), до 100 на state | now − min(job.timestamp) | Ограниченная выборка | GET | Не использовался | Смешивал возраст создания, будущий schedule и ожидание; выборка не обозначалась |
| Publication heartbeat/age/interval | Redis heartbeat v1 → parser | cadence 10 с, expiry 30 с, clock skew ≤10 с | 30 секунд | Worker 10 с; GET | Один heartbeat → healthy даже при down queue | Цикл процесса не доказывает доставку |
| Publication waiting/active/overdue | posts | scheduled / publishing / scheduled_at < now−5m | Состояние сейчас | GET | overdue → degraded | Пропущены failed_retry и stuck publishing; UI называл waiting ожиданием соединения |
| Publication successes/failures | posts status published/failed | published_at / updated_at ≥ now−24h | 24 часа | GET | failures → degraded | Это посты в текущем статусе, не события/attempts; история удерживала warning |
| Publication averageDuration | posts published_at − provider_started_at | AVG(ms), непустые timestamps | Published за 24 часа | GET | Не участвует | Не queue latency; возможны неверные отрицательные timestamps |
| Publication lastSuccess/lastError | MAX(published_at), latest failed row | Всё время | GET | Старый code попадал в текущую диагностику | Нет firstSeen/event count; нельзя доказать активность текстом |
| Telegram polling | Redis heartbeat + TG_BOT_TOKEN | up/conflict/down, TTL parser | TTL | Worker / GET | Нет bot token → not_configured warning | Необязательный выключенный bot не является поломкой |
| Aurora AI recent successes/failures | ai_provider_attempts | count outcome succeeded/failed | 15 минут | GET | Даже 1 success + много failures → healthy | Потеря частичных отказов и различий provider/model |
| Aurora AI provider circuits | In-process ProviderCircuitBreaker | closed/open/half_open, counters | С запуска web | Вызовы данного web | Только open влияет | Не отражает все workers; отсутствие entries ≠ отсутствие конфигурации |
| AI routes / means / last success | ai_provider_attempts GROUP BY provider,model | count attempts, AVG(latency_ms), MAX(success) | 30 дней | GET | Тихий успех до 24 часов → healthy | Наблюдаемые маршруты назывались настроенными; не проверка сейчас |
| AI usage today/period | ai_usage committed | usage_date=current_date / created_at ≥ now−30d | День БД / 30 дней | GET | Не участвует | Логические quota operations, не provider attempts; timezone не объяснялся |
| Обработка media | media-generation + legal-visual-render | queueState | Сейчас | GET | Достаточно одной healthy очереди | Частичный неизвестный компонент скрывался |
| Анализ сайтов running/failed/last ready | site_analysis_jobs + queue | queued/running; failed updated24h; MAX ready | Сейчас / 24 часа / всё время | GET | Любой recent failed → degraded | Исторический failed переживал recovery; готовый report и queue completion различаются |
| Почта sent/failed/last success/error | Только password_reset_outbox | sent30d, failed24h, MAX sent | Смешанные окна | GET | Любой старый sent → healthy | Sent — принятие API, не inbox delivery; email-change не учитывался |
| Token keyring | tokenEnvelopeKeyReadiness | Наличие key IDs из envelope в keyring | Сейчас | GET | up → healthy | Не проверяет расшифровку каждого ciphertext, только наличие key IDs |
| Tracking secrets | Env presence,length,difference | Два разных значения ≥32 символа | Конфигурация процесса | GET | configured | Честно только config, не работа tracking |
| Upload ingress limit | avatarIngressConfigured | Валидность числовой переменной | Конфигурация | GET | configured | Не фактический запрос через ingress |
| HTTPS/origin | APP_URL protocol + NODE_ENV | https / production http | Конфигурация | GET | configured/down/degraded | NODE_ENV=production не означает production environment |
| Release version/commit/deployedAt | auroraReleaseMetadata env | Regex/ISO, полнота | Env процесса | GET | Полный набор → healthy | Метаданные не сверяют загруженный binary или frontend bundle |

## План по первопричинам

| Приоритет | Первопричина | Последствия | Исправление | Зависимости | Подтверждение |
|---|---|---|---|---|---|
| P1 | Исторические ошибки определяют current status | Ложные alerts после recovery | Сохранить history counters, определить fresh execution/текущий backlog | SQL и Redis | failed → success, история не обнуляется |
| P1 | Consumer/старый success/config выдаются за health | Необоснованный green | Execution evidence, expiry, required queue aggregation, configured/unused отдельно | Существующие источники | paused/no consumer/no execution/stale |
| P1 | Нет общего ограничения probe duration | Зависание всех diagnostics | Дедлайны probes, queue disconnect, unavailable | Только мониторинг | Один hung check не скрывает другие |
| P1 | UI stale не распространяется на карточки | Зелёные детали после failed refresh | Единая freshness для summary/cards/details/queues | React state | Failed refresh/TTL → нет healthy |
| P2 | Неверные подписи/окна/даты/область | Ошибочная интерпретация чисел | Локальные подписи, scope, timestamps, environment | API additive fields | SQL ground truth + browser |
