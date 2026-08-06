# Ротация ключей token envelopes

1. Добавить новый secret в secret manager, сохранив текущий в `TOKENS_OLD_KEYS` по его `TOKENS_KEY_ID`.
2. Развернуть оба read keys, не меняя write key, и убедиться, что readiness не показывает неизвестных key ID.
3. Переключить `TOKENS_MASTER_KEY` и `TOKENS_KEY_ID` на новый write key. Старый остаётся только в `TOKENS_OLD_KEYS`.
4. Запускать `npm run tokens:reencrypt` малыми batches. Команда идемпотентна, использует `FOR UPDATE SKIP LOCKED` и не выводит envelope/plaintext/ключи.
5. Проверить readiness и резервную копию; дождаться нулевого batch.
6. Удалить старый read key только после проверки, что его key ID отсутствует в базе.

Rollback до удаления старого ключа: вернуть прежние `TOKENS_MASTER_KEY`/`TOKENS_KEY_ID`, оставить новый ключ в `TOKENS_OLD_KEYS` и повторить batch-команду. При неизвестном key ID или GCM/AAD ошибке batch полностью откатывается.
