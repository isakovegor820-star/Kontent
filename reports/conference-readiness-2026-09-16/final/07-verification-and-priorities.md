# Аврора — проверка, доказательства и оставшиеся приоритеты

## Автоматизированные проверки

| Проверка | Итог | Интерпретация |
|---|---|---|
| Миграции | 118 PASS | additive transactional migration policy прошла |
| Focus/skip audit | PASS | запрещённых focused/skipped tests не найдено |
| TypeScript | PASS | `npx tsc --noEmit` после финальных изменений |
| ESLint | PASS | `npm run lint` после финальных изменений |
| Focused conference/composer | 16/16 PASS | empty state, publication guard, mobile details contract и conference contracts |
| Core focused regression | 65/65 PASS | permissions, drafts, editorial/team и связанные paths |
| Disposable PostgreSQL collaboration | 6/6 PASS | project identity, invitations, concurrent accept, author publish denial, notifications, concurrent owner demotion |
| Full unit/contract suite | **649/649 files, 3704/3704 tests PASS** | Финальный последовательный прогон: 280.27s. Предыдущие 8 failures в параллельном прогоне были resource/time-related и исчезли без изменения тестируемой логики |
| Production build | PASS | Next.js 16.3.4 webpack; compile 2.9 min; TypeScript 27.4s; 248 pages |
| HTTPS health | PASS | HTTP 200, `{"ok":true,"status":"alive"}` |

## Browser retest финальной сборки

| Сценарий | Результат | Evidence |
|---|---|---|
| Landing desktop/320 | no horizontal overflow; demo label visible | `retest/landing-desktop-final.png`, `landing-mobile-320-final.png` |
| Landing axe | 0 violations; 1 color-contrast incomplete group on gradients | axe 4.12.1 JSON output |
| Registration | synthetic account → `/app/onboarding` | normal HTTPS form |
| Login | prepared synthetic account → `/app/calendar` | normal HTTPS form; no cookie import |
| Empty composer | three actions disabled; `Ctrl+Enter` produced no publish request | `composer-empty-actions-disabled-final.png`; network log |
| Sole owner | role/delete disabled; reason visible | `settings-sole-owner-final.png` |
| Calendar axe | 0 violations; dialog `aria-controls` and gradient contrast incomplete | axe 4.12.1 JSON output |
| Calendar 320×568 | scrollWidth=320; final content bottom ~487.5, nav top=511 | `calendar-mobile-320x568-bottom-final.png` |
| Composer mobile 320 | closed secondary actions visible count=0; expanded buttons bottom ~698, nav top=743 | `composer-mobile-320-actions-final.png` |

## Что не проверено

- Live Telegram/VK send, OAuth, provider permissions и real failure/reconcile.
- AI generation, eval quality, cost, latency, model identity и semantic retrieval.
- External search/RSS/site crawl coverage и provenance конкретного результата.
- Object storage upload/download lifecycle.
- Full invite→accept→role actions→revoke→active session flow четырьмя браузерными аккаунтами.
- Dedicated real-DB revoke-vs-in-flight race для каждого draft/editorial write path.
- Ready XLSX/CSV/PDF export и privacy/DSAR export.
- Password recovery email, email/phone confirmation.
- Screen-reader matrix, manual gradient contrast и accessibility certification.
- Pentest, load test, backup restore, disaster recovery, incident drill и production observability review.
- Юридическое заключение, DPA/subprocessors, geography и retention matrix.

## Приоритеты без дедлайнов

### P0 — перед любым использованием реальных клиентских данных

- Зафиксировать data classification: разрешены ли ПДн, специальные категории и адвокатская тайна.
- Утвердить operator/subprocessors/geography/DPA/retention/deletion/incident documents.
- Провести security assessment и проверить production admin access, secrets rotation и backup restore.

**Критерий завершения:** документы и технические controls совпадают; есть named owner и проверяемый evidence pack.

### P1 — перед заявлением о production-командной работе

- Решить policy four-eyes. Если обязательна — server-side запрет self-approval плюс проектная настройка, UI и tests.
- Добавить deterministic PostgreSQL races revoke vs draft edit, editorial submit/decision и invitation/member mutation.
- Пройти четыре роли в независимых browser sessions, включая offboarding и повторный запрос после revoke.
- Выполнить live sandbox Telegram operation с verify/reconcile и controlled provider failure; отдельно VK OAuth/publish, если заявляется.

**Критерий завершения:** каждый сильный claim воспроизводится независимым сценарием до persisted/external result.

### P2 — самостоятельность нового пользователя

- Принять продуктовый выбор: Telegram обязателен до первого draft или доступен локальный draft-first путь.
- Если Telegram обязателен, объяснить prerequisites до регистрации и дать safe demo/sandbox channel.
- Повторить onboarding шаги 1–5, reload/back/deep-link и recovery нормальным browser user.
- Упростить «Контент и стиль»: basic/advanced groups, preview влияния, явный save state.
- Добавить inline hint/error для site analysis.
- Закрыть remaining Radix `aria-controls` incomplete и ручную gradient-contrast проверку.

**Критерий завершения:** новый пользователь проходит первый полезный результат без устных подсказок владельца.

### P2 — доказательность данных и интеграций

- Для analytics/trends/radar показывать provider, run time, coverage, partial/error и формулу.
- Проверить export files содержательно и отделить project export от privacy export.
- Подготовить provider capability/status sheet для каждой среды.

**Критерий завершения:** любое число или статус можно трассировать до источника и времени получения.

### P3 — качество демонстрации

- Проверить формальный/неформальный tone («ты») с целевой аудиторией юрфирм.
- Сократить длинные настройки и сохранить отдельный guided demo path.
- Добавить стабильный demo dataset с явной маркировкой, без попадания в production initial state.

**Критерий завершения:** ведущий не нужен для объяснения базовой навигации, а demo data нельзя принять за реальные показатели клиента.

## Условие остановки публичного показа

Не продолжать live scenario, если health не 200, выбран неверный проект, видны реальные данные, provider status неизвестен, autosave не подтверждён, или действие может отправить/удалить внешний объект. Перейти на подписанную запись и назвать причину.
