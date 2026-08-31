# PostgreSQL pool saturation runbook

Статус: локальный runbook для сигналов приложения. Он не подтверждает PgBouncer,
DB capacity, alert routing или прохождение load gate.

## Обязательный connection budget до production

Значения назначают Backend + SRE по фактическому server/PgBouncer limit. Пустое поле
означает **Требуется решение владельца**, а не default для production.

| Потребитель | Переменная / источник | Утверждённый limit |
| --- | --- | --- |
| Web, на один процесс | `AURORA_DB_POOL_MAX_WEB` | Требуется решение владельца |
| Worker, на один процесс | `AURORA_DB_POOL_MAX_WORKER` | Требуется решение владельца |
| Общий fallback | `AURORA_DB_POOL_MAX` | Требуется решение владельца |
| Web process count | hosting/autoscaling config | Требуется решение владельца |
| Worker process count | hosting/autoscaling config | Требуется решение владельца |
| Migrations/admin reserve | DB/PgBouncer config | Требуется решение владельца |
| PostgreSQL/PgBouncer total | DB/PgBouncer config | Требуется решение владельца |

Проверяемый инвариант budget:

`web max × web process count + worker max × worker process count + migrations/admin reserve`
не превышает утверждённый PostgreSQL/PgBouncer limit и сохраняет требуемые планом
30% capacity headroom. До заполнения всех полей production start через `npm start`
fail-closed.

## Доступный signal

Авторизованный `GET /api/readiness` возвращает `databasePool` для текущего процесса:

- `role`, `max`, `total`, `active`, `idle`, `waiting`;
- `acquireWaitP95Ms`, `acquireSamples`;
- `acquireTimeouts`, `acquireErrors`;
- effective connection/query/statement/idle-transaction timeout.

Endpoint защищён существующим operator bearer или global-admin session и имеет
`Cache-Control: no-store`. Он не агрегирует несколько web/worker processes и не заменяет
DB/PgBouncer dashboard.

## Локальная DB timeout integration — 2026-08-31

Команда `npm run test:database-pool-timeout:integration` создаёт новый изолированный
PostgreSQL 16 cluster в системном temp, запускает приложение с pool max `1` и проверяет
фактические границы без подключения к существующей БД:

- второй `pool.connect()` завершается acquire timeout при занятом единственном connection;
- `select pg_sleep(1)` отменяется PostgreSQL по `statement_timeout` (`57014`);
- idle transaction завершается сервером по `idle_in_transaction_session_timeout`
  (`25P03`), после чего pool создаёт рабочее соединение и `select 1` проходит;
- snapshot не содержит текст исключения и показывает acquire timeout/error counters.

Фактический прогон: 1 test file, 3 tests — pass. Успешный временный cluster остановлен,
а его evidence-каталог сохранён по пути
`/var/folders/l8/4bbq39ws6vz8d9h3dlt95k180000gn/T/aurora-db-pool-timeout-dt3WQA`.
Существующие `aurora_e2e_real`, Redis и production/live targets не использовались.
Это подтверждает только timeout/recovery contract одного локального процесса; тест не
создаёт PgBouncer, controlled saturation/load profile, multi-process aggregation или
production alert route.

## Диагностика

1. Зафиксировать immutable application SHA, runtime role и snapshot каждого process.
2. Сопоставить `waiting`, acquire p95 и timeout counters с PostgreSQL/PgBouncer active,
   waiting и server connection limit за тот же интервал.
3. Разделить web и worker: один общий snapshot нельзя выдавать за per-service capacity.
4. Если `acquireTimeouts` или `acquireErrors` растут, сохранить безопасные error codes и
   correlation IDs; не сохранять SQL parameters, токены или пользовательский content.
5. Если pool wait p95 достигает или превышает 50 ms в целевом load profile, gate не пройден.
6. Slow-query и transaction-duration metrics этим изменением не реализованы. Без них
   первопричина насыщения **не подтверждена** и BLK-02 остаётся частичным.

## Безопасная реакция

- Остановить canary/load profile при росте ошибок, очереди или риске данных согласно
  stop conditions утверждённого плана.
- Не увеличивать pool max без пересчёта полного budget и DB/PgBouncer limit: локальное
  увеличение может усилить saturation.
- Сначала устранить подтверждённую первопричину (долгая транзакция, slow query,
  connection churn, неверное число процессов или отсутствие pooling), затем повторить
  идентичный профиль.
- Timeout не считать успешным recovery. Проверить error contract вызывающего API,
  idempotency операции и отсутствие частичной записи/дублированной публикации.

## Rollback

Если новый pool policy вызывает регрессию, вернуть предыдущий application artifact на том
же immutable configuration target. Изменять только timeout/pool env в пределах заранее
утверждённого budget. После rollback повторно проверить readiness, web smoke, worker
heartbeat, queue recovery и data reconciliation. Сброс или очистка БД в rollback не входят.

## Gate evidence

BLK-02 можно закрыть только после приложения:

- утверждённого connection budget и PgBouncer/equivalent topology;
- DB timeout integration (локальный isolated test есть) и controlled saturation result;
- dashboard с pool/DB/slow-query/transaction signals и рабочим alert route;
- load/soak evidence: pool wait p95 <50 ms, нет connection exhaustion, есть 30% запас;
- повторного identical run и подписей Backend + SRE.
