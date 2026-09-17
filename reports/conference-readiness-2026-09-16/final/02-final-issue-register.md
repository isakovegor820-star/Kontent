# Аврора — итоговый реестр проблем

Исходные шаги, фактическое поведение и evidence сохранены в `../02-baseline-issue-register.md`. Ниже — итог после исправлений и ретеста. `Исправлено` означает изменение первопричины; `перепроверено частично` прямо сохраняет недостающий уровень доказательства.

| ID | P | Суть | Изменение | Ретест | Итог |
|---|---:|---|---|---|---|
| CR-001 | P1 | Пустой редактор говорил «Готово к публикации» | Статус «Черновик не заполнен»; calendar/now/queue disabled; `Ctrl+Enter` требует непустой text | Browser: 0 символов, три disabled; shortcut не создал `/api/publish` request; contracts | **Исправлено и перепроверено** |
| CR-002 | P1 | Личный непроверенный draft выглядел автоматически одобренным | Для personal: «Готово к решению владельца» | Source/contract; смежный empty browser pass | **Исправлено; non-empty wording проверено контрактом** |
| CR-003 | P2 | Normal project reconciliation сразу показывал error/retry | Добавлено neutral «Проверяем текущий проект…»; retry только при `error` | Component test; обычная регистрация сразу открыла onboarding | **Исправлено и перепроверено** |
| CR-004 | P2 | UI позволял удалить/понизить sole owner | Select/delete disabled, `aria-describedby`, видимое объяснение; handler guard | Browser settings + screenshot; server invariant tests | **Исправлено и перепроверено** |
| CR-005 | P2 | Toaster `aria-label` без допустимой роли | Root получил `role="region"` | Landing и calendar axe: 0 violations | **Исправлено и перепроверено** |
| CR-006 | P2 | Невалидная структура `dl/dt/dd` календаря | Введён валидный wrapper для term/definition pairs | Calendar axe: 0 violations | **Исправлено и перепроверено** |
| CR-007 | P2 | Burger ссылался на отсутствующий drawer | `aria-controls` задаётся только при открытом target | Contract/source; calendar axe больше не показывает burger defect | **Исправлено**; два Radix dialog `aria-controls` остались axe-incomplete |
| CR-008 | P2 | Bottom nav перекрывал mobile content | Сохранён общий 80 px inset; найден и устранён отдельный CSS overflow закрытого `<details>` | 320×568 calendar: last content ~24 px над nav; composer expanded actions ~45 px над nav | **Исправлено и перепроверено** |
| CR-009 | P2 | Trust labels ~3.02:1 | Text изменён на `#667085` | Landing axe: 0 violations; gradient checks remain incomplete | **Исправлено по статическому фону; gradient ручная проверка остаётся** |
| CR-010 | P3 | Copyright ~2.98:1, VK ~3.57:1 | Footer `#667085`, VK `#1769c2` | Landing axe: 0 violations | **Исправлено и перепроверено** |
| CR-011 | P3 | Hero metrics не были помечены как demo | Видимая pill «Демонстрационный пример» | Desktop/320 browser и screenshot | **Исправлено и перепроверено** |
| CR-012 | P2 | Onboarding обещал материал вместо обязательного Telegram | Copy прямо называет обязательное подключение и переход | Source; normal browser достиг step 2 с disabled «Дальше» | **Исправлена формулировка**; обязательность Telegram остаётся product constraint |
| CR-013 | P2 | Production store начинался с coffee demo seed | `emptyState/emptySettings`; все init/reset/error fallbacks заменены, `seedState` оставлен fixtures | Contract tests; новый аккаунт не получил coffee data | **Исправлено и перепроверено** |
| CR-014 | P2 | README/release scope противоречили runtime | Документы приведены к полной authenticated surface и evidence limits | Doc/source review, conference readiness contract | **Исправлено** |
| CR-015 | P2 | «Контент и стиль» перегружен | Не менялся: нужен отдельный IA/design pass | — | **Осталось** |
| CR-016 | P3 | Site analysis без устойчивого inline hint/error | Не менялся | — | **Осталось** |
| CR-017 | P1 | Revoke мог завершиться, а in-flight draft/editorial/team write — позже | `requireSelectedProjectPermission(..., {lock:true})`; member/project lock options; team mutations повторно проверяют actor under deterministic row locks | 65 focused tests; disposable PostgreSQL project-collaboration 6/6 | **Исправлено; перепроверено частично** — нет отдельной DB race для каждого draft/editorial path |
| CR-018 | P1* | Owner/approver может сам согласовать материал | Не менялось: продуктовая политика, а не безопасный patch | Code review | **Осталось и раскрыто**; нельзя обещать mandatory four-eyes |
| CR-019 | P2 | Cross-project reuse client key давал 500 | Явный `DraftValidationError(client_key_project_conflict)` и HTTP 409 | Unit/API tests | **Исправлено и перепроверено** |
| CR-020 | P2 | Retest: demo dashboard имел `aria-label` на generic `div` | Добавлен `role="group"` | Landing axe: ARIA incomplete исчез | **Найдено, исправлено и перепроверено** |
| CR-021 | P2 | Retest: закрытый `<details>` оставлял secondary actions в mobile layout | Content `hidden`, раскрывается только через `group-open:grid` | Contract; 320 px closed visible actions=0; expanded buttons выше nav | **Найдено, исправлено и перепроверено** |

\* CR-018 становится P1 только если на сцене или в договоре заявляется обязательное независимое согласование. Для текущей модели это известная продуктовая граница.

## Оставшиеся axe/manual вопросы

- Landing: 0 violations, но axe не вычислил контраст 119 элементов поверх градиентов/псевдоэлементов; это `incomplete`, не pass и не fail.
- Calendar: 0 violations, но два trigger-а Radix с `aria-controls` на портальные dialog targets отмечены `incomplete`; визуально и клавиатурно их полный lifecycle в этом ретесте не проходился.
- Доступность не сертифицирована; screen-reader matrix и ручная проверка gradient contrast остаются.

## Не являются дефектами этого прохода

- 403 login без `Origin` в раннем automation — корректный CSRF fail-closed; обычная HTTPS-форма позднее вошла успешно.
- Negative synthetic Telegram id непригоден для provider link-check.
- Cold compile / memory pressure dev-runtime не воспроизведены как production build defect.
- Блокировка onboarding до Telegram последовательна с текущим product rule.
- Отсутствие live AI/social evidence означает «не проверено», а не автоматически «не работает».
