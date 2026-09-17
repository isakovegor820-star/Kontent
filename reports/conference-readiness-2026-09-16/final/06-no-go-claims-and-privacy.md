# Аврора — утверждения, которые нельзя использовать, и privacy fact sheet

## Нельзя говорить на сцене

- «Аврора гарантирует юридическую правильность» или «ИИ исключает ошибки».
- «Без независимого согласующего публикация технически невозможна».
- «Telegram/VK точно работают в любом аккаунте без настройки».
- «Все внешние источники и тренды покрыты полностью».
- «71% заполнения недели — результат клиента, экономия времени или рост продаж».
- «Аврора заменяет CRM, систему ведения дел, ЭДО или хранилище клиентских материалов».
- «Доступ отзывается мгновенно во всех активных операциях и сессиях».
- «Данные никому не передаются».
- «Данные хранятся только в России/ЕС».
- «Удаление происходит мгновенно из основной базы, логов и всех backup».
- «Продукт полностью соответствует 152-ФЗ, GDPR или требованиям адвокатской тайны».
- «Экспорт в UI — полная DSAR-выгрузка аккаунта».
- «Продукт бесплатен» или «тариф окончательно определён».
- «Axe 0 violations означает полную сертифицированную доступность».
- «Успешная репетиция доказывает production readiness».

## Допустимые формулировки

| Рискованная тема | Формулировка, которую можно защитить |
|---|---|
| Юридическая проверка | «Аврора помогает связать утверждение с источником, датой, версией и решением; финальную оценку принимает специалист» |
| Командная работа | «Проектные роли и история решений реализованы; обязательный второй согласующий пока не является системной политикой» |
| Telegram | «Контур Telegram реализован и требует корректных bot/channel permissions; live sandbox send в этом аудите не выполнялся» |
| VK | «Интеграция зависит от отдельной настройки; сегодня live VK не демонстрируем» |
| ИИ | «ИИ готовит рабочий вариант, который проверяет человек; модель, качество и стоимость зависят от настроенного provider» |
| Аналитика | «Показываем только метрики с понятным источником, периодом и формулой; ROI без данных клиента не заявляем» |
| Security | «Есть перечисленные технические controls; compliance и остаточный риск оцениваются отдельно» |
| Изоляция | «Project-scoped проверки и тесты защищают границы workspace; абсолютную гарантию без security audit не даём» |
| Экспорт | «Есть проектный экспорт контента/аналитики; полную privacy-выгрузку этим не обещаем» |

## Какие данные обрабатываются

| Категория | Примеры | Где и зачем | Возможные получатели | Подтверждено / не хватает |
|---|---|---|---|---|
| Account identity | имя, email, password verifier, avatar, provider IDs | PostgreSQL; auth/profile | email/storage providers при выбранном действии | scrypt/password hashing и hashed session verifier есть; retention/DSAR не конкретизированы |
| Project/team | project name, timezone, membership, role, invitations | PostgreSQL; collaboration/RBAC | first-party server/admin | project scope есть; staff access и active-session offboarding не описаны полностью |
| Content | drafts, versions, evidence, comments, schedules | PostgreSQL, object storage, Redis jobs | AI/social/storage providers по действию | нельзя загружать client secrets до policy/DPA и legal decision |
| External credentials | bot/provider tokens | encrypted DB fields/runtime secrets | соответствующий provider | AES-GCM/keyring code есть; rotation и operational access требуют подтверждения |
| Analytics/telemetry | publication metrics, product events, errors | PostgreSQL; Sentry при включении | social providers/Sentry | events cleanup path есть; единой retention matrix нет |
| Public research | sites, RSS, trends, competitors | DB/queues/external HTTP/search/AI | crawled sites, search/AI providers | provenance/coverage и legal basis показываются для конкретного результата |

## Технические меры, которые действительно найдены

- Password hashing и hashed session verifier.
- CSRF/origin fail-closed для state-changing auth.
- Project-scoped permission checks и selected-project context.
- Membership locks для найденных transaction write paths.
- Exact revision/hash/version для editorial decision.
- Idempotency, outbox, lease/reconcile и duplicate fences для publication operations.
- Token encryption/keyring, CSP, rate limits и часть audit trails.
- Fail-closed provider capability registry.

Это не сертификат, pentest, доказательство безошибочности или юридическое заключение.

## Что нужно подтвердить оператору и профильному юристу

1. Юридическое лицо-оператор, контакты, юрисдикции и категории пользователей.
2. Hosting/database/storage/mail/Sentry/AI/social subprocessors, DPA/SCC и страны обработки.
3. Допустимы ли персональные данные клиентов, специальные категории и адвокатская тайна; если нет — явный запрет.
4. Используют ли AI providers пользовательский контент для обучения и каков opt-out.
5. Retention/deletion по аккаунтам, drafts, evidence, audit logs, metrics, queues и backups.
6. DSAR: доступ, исправление, переносимость, ограничение, удаление, формат и срок.
7. Incident response: контакт, detection, уведомление, RTO/RPO.
8. Кто из персонала имеет production/admin access и как он журналируется.
9. Регион хранения и резервного копирования фактического production.
10. Тарифы, лимиты и условия изменения цены.

## Безопасный ответ до получения документов

«Мы можем показать конкретные технические меры, фактический поток данных и известные границы. Юридическое соответствие, допустимость клиентских материалов, география и договорные гарантии подтверждаются отдельными документами и оценкой для конкретной юрисдикции».
