# Аврора — исходный реестр находок

Зафиксировано до изменения исходников. `Подтверждённый дефект` означает воспроизводимое несоответствие, а не предположение по одному экрану. Средовые ограничения и идеи новой функции вынесены отдельно.

## Подтверждённые проблемы

| ID | Приоритет | Тип | Шаги / фактическое поведение | Ожидание и последствие | Исходное доказательство | План проверки исправления |
|---|---:|---|---|---|---|---|
| CR-001 | P1 | Вводящий в заблуждение статус | Открыть новый пустой `/app/composer`: виден статус «Готово к публикации» и активные действия | Пустой материал должен называться незаполненным и не предлагать публикационные действия; иначе аудитория может принять статус за проверку | D UX-01 screenshot `editor.png` | UI contract + browser retest empty/non-empty/personal/team |
| CR-002 | P1 | Понятность юридической проверки | Личный непроверенный черновик с Evidence Card «Проверка недоступна» одновременно показывает «Готово к публикации» | Сохранить право owner, но назвать это ручным решением владельца, не заключением платформы | B-003 screenshots | UI contract + browser retest |
| CR-003 | P2 | Ошибка начального состояния | Сразу после регистрации/reload initial project reconciliation показывал аварийный текст и кнопку ещё до установленной ошибки; dev latency делала это похожим на сбой | Пока запрос идёт, показывать нейтральное «Проверяем…»; recovery только после реальной ошибки | A-001, B-002, C screenshots; source overlay condition | Component test + production-like browser retest |
| CR-004 | P2 | Предотвращение ошибки | У единственного owner доступны смена роли и удаление | Серверный invariant уже должен отклонять действие, но UI обязан заранее объяснить необходимость второго owner | B-004, D settings screenshot | UI contract + API invariant test |
| CR-005 | P2 | Accessibility | Toaster root — `div aria-label` без допустимой роли | Корректный named region/live semantics; повторяется на landing/calendar/composer/settings | axe D UX-03 | component/source contract + axe retest |
| CR-006 | P2 | Accessibility | `WeekSummary` вкладывает `dt/dd` внутрь дополнительных `div` в `dl` | Валидная definition-list либо list semantics | axe D UX-03 | source contract + axe retest |
| CR-007 | P2 | Accessibility | Burger постоянно ссылается `aria-controls=app-drawer`, хотя target не смонтирован при закрытом меню | Не оставлять ссылку на отсутствующий target либо держать target в DOM | axe incomplete/manual inspection | component/source test + axe retest |
| CR-008 | P2 | Mobile layout | `/app/calendar`, 320x568: fixed bottom navigation визуально перекрывает рабочую область | Контент должен иметь safe-area/padding по фактической панели | D UX-02 screenshots | browser 320/390 after change |
| CR-009 | P2 | Accessibility | Landing trust labels имеют contrast около 3.02:1 | Минимум 4.5:1 для обычного текста | baseline axe + D | axe retest |
| CR-010 | P3 | Accessibility | Footer copyright около 2.98:1; VK badge около 3.57:1 | Минимум 4.5:1 | baseline axe + D | axe retest |
| CR-011 | P3 | Честность demo | Hero показывает `5 публикаций`, `2 на согласовании`, `71%`, `3 из 4` без маркировки | Пометить сцену «Демонстрационный пример» | A-003 | визуальный/browser retest |
| CR-012 | P2 | Product copy | Onboarding говорит «проверить канал и сохранить первый материал», хотя реальное блокирующее условие — Telegram | Текст должен прямо называть переход и обязательное подключение, без неподтверждённого обещания сохранения | A-002 + source | source/browser retest |
| CR-013 | P2 | Данные/demo contamination | Client store использует кофейный `seedState()` как initial/reset/error fallback | Новый реальный workspace должен стартовать пустым; demo seed допустим только в fixtures | source inspection; coffee content in `mock.ts` | unit contract for empty state + full tests |
| CR-014 | P2 | Документация | Release-scope документ объявляет Today/Studio/etc вне релиза, а runtime `STABLE_RELEASE_CAPABILITIES` включает весь signed-in app; README содержит устаревшие routes/claims | Документация должна описывать текущую release boundary и реальные ограничения | source/doc comparison | doc/source contract review |
| CR-015 | P2 | Information architecture | «Контент и стиль» — длинный несгруппированный экран | Новый пользователь плохо различает базовые/продвинутые настройки | D UX-04 | Остаётся: требует отдельного дизайна, не точечного conference patch |
| CR-016 | P3 | Form feedback | Site analysis полагается на native required без устойчивого inline hint/error | Связать подсказку/ошибку через `aria-describedby` | D UX-05 | Остаётся, если не затрагивать форму в текущем patch |
| CR-017 | P1 | Access concurrency | Draft/editorial/team write-path проверяет membership внутри транзакции без удержания lock до commit; конкурентный revoke может завершиться раньше, а уже начатая запись — позже | Отзыв роли должен конфликтовать с защищённой write-транзакцией; права нельзя использовать после завершившегося revoke | E T-01, source/SQL trace | Lock contract unit tests + disposable PostgreSQL race pending |
| CR-018 | P1 для compliance-обещания | Product policy | `owner`/`approver` может создать и сам согласовать материал | Не называть текущий approval обязательным независимым four-eyes; изменение правила требует продуктового решения | E T-02, permission/workflow code | Остаётся как честно раскрытое ограничение |
| CR-019 | P2 | Idempotency scope | Unique `(user_id, client_key)` глобален, replay lookup был project-scoped; reuse ключа в другом проекте приводил к 500 | Fail-closed должен давать явный конфликт, не неразрешимый server error | E T-03, schema/server code | Unit + API status contract |

## Не подтверждены как продуктовые дефекты

| Наблюдение | Классификация | Почему не дефект |
|---|---|---|
| HTTP login вернул 403 без `Origin` | Корректный security fail-closed / ограничение QA-драйвера | Production требует same-origin HTTPS; обычная браузерная форма должна послать Origin |
| Telegram bot-link не принимает отрицательный synthetic `tg_chat_id` | Ограничение fixture | Реальный Telegram ID должен быть положительным safe integer; live account не использовался |
| Первые dev-переходы занимали десятки секунд/минуты | Артефакт cold compile и memory pressure | Production build отдельно прошёл; latency не воспроизведена как production-дефект |
| Нельзя пройти onboarding без Telegram | Product constraint / проблема удобства | Поведение последовательно заложено; изменение правила требует продуктового решения |
| Реальные Telegram/VK, AI и внешняя аналитика не доказаны | Непроверено | Проверка намеренно не выполняла внешние действия и не имела credentials |
| Полная accessibility проверка элементов поверх градиентов | Требует ручной проверки | axe вернул incomplete, а не fail |

## Предложения новой функции, не исправления

- Позволить создать локальный первый черновик до подключения Telegram.
- DSAR/account data export и self-service удаление аккаунта.
- Свернуть advanced-настройки и добавить preview влияния параметров.
- Отдельный demo mode с гарантированно синтетическими данными и явной маркировкой.

Эти пункты не должны внедряться как «быстрые исправления»: они меняют product flow, privacy operations или модель данных.
