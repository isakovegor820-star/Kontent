# Восстановление доступа существующего администратора

Механизм: `.github/workflows/production-admin-access-recovery.yml` и
`scripts/production-admin-access-recovery.mjs`. Он выпускает обычный одноразовый
password-reset token для уже разрешённого аккаунта. Он не создаёт администратора
и не меняет allowlist. Production запуск, запись repository/environment secret и
передача артефакта требуют отдельного разрешения на конкретный аккаунт и получателя.
Наличие инструкции или зелёного теста не является таким разрешением.

## Подготовка и проверяемый пакет

1. Установите точный 40-символьный deployed SHA и ID существующего администратора
   разрешённой read-only проверкой. Email-путь требует совпадающего подтверждённого
   адреса; заблокированный аккаунт не допускается. `userId: 0` допустим только если
   в allowlist ровно один подходящий аккаунт; при неоднозначности укажите точный ID.
2. На доверенном компьютере оператора с закрытым локальным каталогом (`umask 077`)
   создайте случайный 32-байтный token в base64url, его SHA-256 по UTF-8 строке,
   новый UUID `operationId` и RSA key pair не короче 2048 бит. Для Node это
   `randomBytes(32).toString('base64url')`, `createHash('sha256')` и `randomUUID()`.
   Сохраните token и private key только локально; не помещайте их в командную
   строку, chat, git, CI input, secret payload или логи.
3. Подготовьте JSON для `AURORA_ADMIN_RECOVERY_PAYLOAD` с ровно нужными значениями:
   `tokenHash`, `operationId`, числовой `userId`, `publicKey` в PEM. Передавайте
   только hash и public key. Пакет согласования включает целевой SHA, аккаунт,
   operation ID, исполнителя, утверждённого получателя и место хранения ciphertext.

## Исполнение после отдельного разрешения

Workflow запускается только на `main`, в environment `production`, с input
`expected_deployed_sha`; он сериализован с production-deploy. SSH identity должна
пройти проверку известного host key и fingerprint. Deployed SHA проверяется до
чтения production env и вызова скрипта. При несовпадении выясните причину; не
подменяйте ожидаемый SHA автоматически.

Транзакция блокирует аккаунт и operation ID, повышает reset generation, помечает
прежние неиспользованные reset tokens использованными и сохраняет новый hash на
30 минут. Аудит `operator.admin_password_recovery_issued` содержит operation ID,
token row ID и workflow run ID, без token/password. Выпуск ещё не меняет пароль
и не завершает сессии; это делает штатное успешное завершение password reset.

Результат — артефакт `admin-recovery-sealed` со сроком хранения в Actions один день.
Внутри JSON версии 1: `algorithm: RSA-OAEP-SHA256+A256GCM`, поля base64 `key`, `iv`,
`tag`, `ciphertext`. Локально расшифруйте `key` private key через RSA-OAEP-SHA256,
затем ciphertext через AES-256-GCM с сохранёнными iv/tag. Проверьте operation ID,
user ID, HTTPS origin и срок действия расшифрованных метаданных.

Соберите URL `<origin>/reset-password#token=<локальный token>` и откройте на
доверенном компьютере. Token должен быть во fragment, не в query string.
Задайте новый пароль штатной формой; затем проверьте вход и доступ `/admin`, а
также недоступность прежней сессии. Не передавайте URL или plaintext token через
журналы и отчёты. Завершив восстановление, уберите временные локальные материалы
и временный payload в соответствии с утверждённым порядком хранения.

## Неоднозначный результат и ошибки

Потеря ответа не означает rollback. Повтор с теми же operation ID, аккаунтом и
hash возвращает metadata существующего ещё пригодного токена, не создавая второй
token и запись аудита. Использованный, истёкший или вытесненный reset generation
даёт `recovery_operation_used`; подмена аккаунта/hash — `recovery_operation_mismatch`.
Новый operation ID требует нового осознанного выпуска: он аннулирует предыдущие
неиспользованные reset tokens.

`recovery_admin_not_found`, `recovery_admin_ambiguous`, `recovery_admin_blocked`
требуют проверки существующей авторизации; нельзя обходить их выдачей новых прав.
`recovery_payload_invalid`, `recovery_key_invalid`, `recovery_origin_invalid`
требуют исправить подготовленный пакет. Обобщённый `admin_recovery_failed` не
раскрывает детали; выясняйте состояние по operation ID и разрешённым журналам.

Локальные гарантии проверяют `worker/production-admin-access-recovery.test.mjs`
и `src/e2e/admin-access-recovery.integration.ts` из CI; они не подтверждают доступ к реальному аккаунту,
доставку артефакта конкретному оператору или production запуск.
