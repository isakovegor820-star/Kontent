# Пострелизные операционные проверки (mail, алерты, staging)

Операционные пункты аудита 2026-09-30, которые невозможно закрыть кодом.
Каждый пункт: критерий приёмки и ответственный (оператор/release owner).

## 1. Почта (password recovery) — сейчас degraded

Производство работает в профиле `release` (`ALLOW_DEGRADED_MAIL=true`), т.е.
доставка писем не входит в обязательные проверки, и восстановление пароля в
проде не доказано.

Шаги:
1. Завести/подтвердить домен отправителя в Resend, задать `RESEND_API_KEY`,
   `EMAIL_FROM` (см. `.env.example`, секция «Почтовый сервис»).
2. Установить `ALLOW_DEGRADED_MAIL=false` (GitHub environment `production`).
3. Перезапустить deploy-проверку: `npm run test:deployment-smoke` с профилем
   `full` должен вернуть `passwordRecoveryReady: true`.
4. Ручной тест: forgot-password → письмо → сброс → вход.

Приёмка: readiness `status=ready`, `passwordRecoveryReady=true`, письмо получено.

## 2. Доставка алертов

Приложение пишет `[operational_signal]` в логи; пейджинг — обязанность внешней
лог-платформы (см. `docs/production-operational-alerts.md`).

Шаги:
1. Настроить парсинг `marker=aurora_operational_signal` в лог-платформе.
2. Создать алерты по таблице из `docs/production-operational-alerts.md`
   (минимум: `recovery_failed` → page, `delivery_unknown` → page в рабочее время).
3. Тест доставки: сгенерировать тестовый сигнал (например, временно остановить
   heartbeat воркера на staging-копии) и убедиться, что ответственный получил
   уведомление.

Приёмка: тестовый сигнал дошёл до ответственного, скриншот/протокол сохранён.

## 3. Staging-копия

Отдельного staging в репозитории нет; Gate C плана readiness требует репетиции
на копии с той же историей миграций.

Шаги:
1. Поднять staging (VPS/VM): `pg_restore` снапшот прода в отдельную БД,
   `Deploy production`-совместимый layout (`/opt/aurora-*`, systemd-юниты).
2. Прогнать Gate C: baseline smoke → миграции → tenant A/B → rollback drill
   (старый код на новой схеме) → полный smoke.
3. При изменении migration manifest записать точную пару
   `SCHEMA_ROLLBACK_AUDIT=<previous-sha>:<target-sha>`.

Приёмка: протокол Gate C приложен к релизу, rollback drill успешен.

## 4. После закрытия 1–3

Перевести следующие релизы на профиль `full` (без `ALLOW_DEGRADED_MAIL`) и
обновить таблицу «Текущее доказанное состояние» в плане readiness.
