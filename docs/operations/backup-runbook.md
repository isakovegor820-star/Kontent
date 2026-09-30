# Бэкапы и восстановление (runbook)

Статус: операционная задача из аудита 2026-09-30. В репозитории автоматизации бэкапов
не было; этот документ фиксирует целевые RPO/RTO, порядок и критерии приёмки Gate D
плана production readiness (`docs/production-readiness-plan-2026-08-20.md`).

## Цели

| Показатель | Цель | Как меряем |
| --- | --- | --- |
| RPO | ≤ 5 минут | `pg_dump` каждые 5 минут или WAL-архивация (`archive_command`) |
| RTO | ≤ 30 минут | репетиция восстановления в отдельную БД, засекаем время |
| Снапшот перед миграцией | обязателен | шаг до `npm run db:migrate` при каждом релизе |

## Штатный порядок

1. Установить в root-крон (или systemd timer) на хосте:

```bash
# /etc/cron.d/aurora-backup
*/5 * * * * postgres pg_dump -Fc "$DATABASE_URL" | gzip > /opt/aurora-backups/aurora-$(date +\%Y\%m\%dT\%H\%M\%SZ).dump.gz
```

   Значения `DATABASE_URL` держите в root-only файле; в крон-файл секреты не пишутся.
2. Ретенция: хранить 48 часов 5-минутных снапшотов + 14 дневных. Старше — удалять.
3. Перед КАЖДЫМ релизом (Gate B/C): сделать ручной снапшот с именем
   `pre-migrate-<target-sha>.dump.gz` и записать его в release-протокол.
4. Раз в месяц (или после значимых изменений схемы): полная репетиция
   восстановления — см. ниже. Протокол хранить в репозитории/вики.

## Репетиция восстановления (обязательна для Gate D)

```bash
createdb aurora_restore_rehearsal
pg_restore --no-owner --dbname aurora_restore_rehearsal /opt/aurora-backups/<свежий>.dump.gz
# сверка: число строк в users/channels/posts + последний applied migration
# затем: dropdb aurora_restore_rehearsal
```

Приёмка: восстановление прошло без ошибок, сверка строк сходится, время
зафиксировано (RTO). Без этого Gate D плана readiness считается непройденным.

## Проверка в репозитории

`production-storage-inventory` workflow уже мерит `/opt/aurora-backups`
(`aurora_backups_bytes`) — убедитесь, что значение растёт и не равно 0.

## Запрещено

- Восстанавливать поверх живой БД без предварительного снапшота.
- Откатывать миграции назад (forward-only политика `scripts/migrate.mjs`).
