# ADR 0001: граница workspace и сквозная модель ролей

- Статус: proposed
- Дата: 2026-08-06
- Область: product architecture, authorization, data isolation

## Контекст

Сейчас Aurora использует прямое владение через `user_id` и местами `channel_id`. Это подходит
для личного кабинета, но не позволяет безопасно дать доступ редактору или согласующему. Добавлять
отдельные проверки ролей в UI нельзя: до реализации общей границы данных PostgreSQL и API должны
оставаться в текущем owner-scoped режиме.

## Решение

`workspace` — контейнер одного бренда или клиента. Организация/агентство является отдельным уровнем,
который может иметь несколько workspace. Такой выбор сохраняет отдельные бренд-настройки, знания,
лимиты AI и интеграции даже тогда, когда одна команда обслуживает несколько клиентов.

На первом этапе один канал принадлежит ровно одному workspace. Совместное использование канала
несколькими workspace запрещено: оно делает неоднозначными бренд-контекст, бюджет, согласование и
получателя публикации. Если продукту понадобится кросс-брендовый канал, это должна быть отдельная
сущность назначения с явными policy, а не второй внешний ключ.

Роли внутри workspace:

- `owner` — владение, billing, удаление workspace, управление всеми участниками и интеграциями;
- `admin` — участники, настройки и каналы, кроме передачи владения и удаления workspace;
- `editor` — черновики, медиа и AI-генерация; не может подключать канал и публиковать без policy;
- `approver` — просмотр и approve/reject подготовленных immutable revisions, публикация и отмена;
- `viewer` — только чтение календаря, истории и аналитики без доступа к plaintext токенам.

Approve обязателен для публикации или reschedule, если автор revision не имеет `approver`, а также
для первой публикации в новый канал и для workspace с включённым mandatory approval. Самосогласование
редактором запрещено. Отмена до provider call доступна approver/admin/owner; после начала вызова она
подчиняется существующему `publication_in_progress` и reconciliation lifecycle.

## Изоляция данных

`workspace_id` становится обязательной tenant boundary для channels, drafts и revisions, knowledge,
AI logical operations/usage, media metadata/object keys, publication operations/posts/outbox/parts и
provider credentials. Tokens остаются недоступны приложению как обычные данные: запись ссылается на
workspace и channel, расшифровка требует проверенного действия и минимального service capability.
Все запросы сначала устанавливают membership и permission, затем фильтруют по `workspace_id`; одного
`channel_id` или переданного клиентом `user_id` недостаточно.

## Миграция текущего владения

1. Для каждого существующего пользователя создать personal workspace и membership `owner`.
2. Backfill `workspace_id` по текущему `user_id` малыми идемпотентными batches с dual-read проверкой.
3. Добавить составные foreign keys/unique constraints, исключающие ссылки между workspace.
4. Перевести writes на обязательный workspace context, сверять старое и новое owner scoping.
5. После reconciliation и метрик расхождений сделать `workspace_id not null`; `user_id` оставить как
   `created_by`/`updated_by`, а не tenant boundary.
6. Включать RBAC только после negative integration tests на каждую mutation и worker path.

## Audit log

Нужен append-only журнал: workspace, actor user/service, actor role, action, target type/id, request ID,
operation/revision, безопасные before/after status, decision (`allowed`/`denied`), policy version, time и
safe error code. Обязательные события: membership/role changes, channel connect/disconnect/reconnect,
token rotation, draft approval/rejection, schedule/reschedule/cancel, worker claim, provider outcome и
ручная reconciliation. Токены, cookies, пароли, полный prompt/текст и media bytes не записываются.

## Последствия

Это решение добавляет tenant context во все слои и требует миграции данных и authorization matrix.
До отдельного проекта реализации Aurora остаётся однопользовательской: общие учётные записи и
частичные UI-роли не поддерживаются и не должны рекламироваться.
