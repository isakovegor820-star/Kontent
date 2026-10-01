# Redis: политика персистентности и вытеснения (операционная)

Статус: операционная задача из аудита 2026-09-30. Файл фиксирует требуемую конфигурацию;
само изменение выполняется оператором на сервере.

## Зачем

Redis держит delayed publish-джобы и расписания BullMQ Job Scheduler. Потеря ключей
означает: пропущенные публикации (страховка — durable outbox с replay `enqueued`-строк)
и пропущенные cron-тики (страховка — догоняющий weekly при старте воркера). Страховки
работают, но полагаться на них как на штатный режим нельзя.

## Требуемая конфигурация

```
# redis.conf (или эквивалент у провайдера)
maxmemory-policy noeviction     # ключи с данными не должны вытесняться молча
save 900 1                      # RDB: снапшот при изменении
save 300 10
appendonly yes                  # AOF: переживает потерю последнего RDB
appendfsync everysec
```

- `noeviction` обязателен: BullMQ-джобы — это расписание, их вытеснение = тихая потеря публикации.
- RDB+AOF: RPO в пределах секунд при `everysec`.
- Логическая БД публикаций — отдельный namespace (см. `REDIS_URL`), не смешивать с кешами.

## Проверка приёмки

```bash
redis-cli CONFIG GET maxmemory-policy   # -> noeviction
redis-cli CONFIG GET appendonly         # -> yes
redis-cli INFO persistence              # rdb_last_save_time / aof_enabled:1
```

Принято, когда: политика зафиксирована, значения подтверждены на сервере, и
`deploy/systemd`-README ссылается на этот документ.
