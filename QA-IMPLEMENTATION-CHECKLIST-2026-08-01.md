# Aurora QA implementation checklist — 2026-08-01

Рабочая матрица исправлений из `../QA-REVIEW-2026-08-01.md`. Статус `verified`
означает только явно указанную проверку; mock/fixture не выдаётся за live-проверку.

## Baseline и сохранность

- Рабочее дерево до исправлений уже было dirty: 68 tracked-файлов, 4 857 добавлений,
  2 478 удалений и существующие untracked-файлы. Reset/stash/checkout/commit/push не выполнялись.
- Baseline `npm test`: 33 файла, 270/270 тестов — pass.
- Baseline `npm run lint`: pass.
- Baseline production build: завис на `Creating an optimized production build ...`, `BUILD_ID`
  не появился за 90 секунд. Причины: Turbopack в этом дереве, сетевой `next/font/google`
  и route-only export, который Next пытался интерпретировать как route contract.
- Общий worker не запускался; текущие Redis/PostgreSQL не очищались и не изменялись;
  внешних публикаций не было.

## Матрица 16 проблем аудита

| Проблема | Reproduced | Fixed | Verified | Blocked/live gap | Основное доказательство |
|---|---:|---:|---:|---:|---|
| P0 bulk approve переносит expired на `now + 120s` | yes | yes | yes, deterministic | live queue не запускалась | Fail-closed freshness/quality/channel checks, durable outbox/lease/fencing, replay и partial-state tests |
| P1 AI заканчивается серией timeout | yes | yes | yes, fake adapters | live provider SLA | First-token/overall deadlines, provider health/circuit breaker, automatic fallback, actionable stream errors |
| P1 missing Telegram показывается как published | yes | yes | yes, mock state machine | live Telegram reconciliation | External ID/verification states, temporary-error preservation, confirmed missing, hidden invalid links |
| P1 draft теряется после reload | yes | yes | yes, API/domain tests | authenticated multi-device staging | Server drafts, idempotent create/update, version conflicts, revision autosave, ACK-gated delete |
| P1 garbage profile/RSS/missing смешиваются с voice | yes | yes | yes | human voice evaluation | Field-level effective profile provenance; verified live/manual samples only; channel isolation |
| P1 отсутствие quality выглядит как 100/100 | yes | yes | yes | none | `Не проверено`, timestamp/rules/provenance/blockers; unverified item cannot bulk-approve |
| P1 password recovery отсутствует | yes | yes | yes, isolated tests | real email delivery | Generic enumeration-safe response, single-use hash token, expiry, fail-closed rate limit, session revoke |
| P2 Calendar смешивает server data с coffee demo | yes | yes | yes, source/tests | authenticated visual staging | Real account renders server drafts/posts only; legacy account-wide data stays unassigned instead of guessed |
| P2 Analytics использует разные/stale cohorts | yes | yes | yes | live Telegram cohort | One verified cohort, reproducible denominator, missing/unverified exclusions, explicit unavailable state |
| P2 screens показывают разные AI quotas | yes | yes | yes, deterministic | multi-tab staging | Shared reservation ledger/worker policy and `aiUsageStatus`; local optimistic counter removed |
| P2 UI обещает недоступные social/destinations | yes | yes | yes, browser/source | real OAuth not configured | OAuth CTA disabled until supported; Composer derives only active real destinations; TG-only does not select VK |
| P2 Trends load делает hidden POST | yes | yes | yes | none | Initial/navigation fetches are GET-only; explicit refresh is idempotent POST with channel |
| P3 password eye пропущен клавиатурой | yes | yes | yes, browser keyboard | screen-reader matrix | Focusable button with accessible name and visible focus state |
| P3 mobile Calendar/Composer плохо сканируется | yes | yes | partial, 390×844 | authenticated content state | No horizontal overflow; compact mobile controls/cards/error states; authenticated card density needs staging pass |
| Content guard пропускает unsupported claims/contrast | yes | yes | yes, five golden briefs | live semantic provider intentionally absent | Fact ledger, preflight, deterministic blockers, semantic fail-closed `requires_review`, versioned human ACK |
| Generated copy не сохраняет channel voice/facts | yes | yes | deterministic | blinded human review; live corpus мал | Verified context/voice samples, exact-fact checks, all five audience groups and announcement/legal regressions |

## Gate evidence

- Gate 1: expired/no-quality/wrong-channel/replay/partial failure/crash-window/outbox reclaim
  покрыты `autopilot-approval` и `autopilot-scheduling` tests.
- Gate 2: Telegram publish/reconcile state machine и единая analytics cohort покрыты mock tests;
  live post по ограничениям не создавался.
- Gate 3: server draft API/model, ownership, idempotency, optimistic version и AI review version
  покрыты route/domain tests. Реальная cross-device сессия требует staging DB.
- Gates 4–5: provider fake adapters, reservations, cancellation/fallback, five factual briefs,
  semantic fail-closed и quality provenance покрыты deterministic tests. Live AI не вызывался.
- Gate 6: password reset, destination/OAuth capability, demo isolation и read-only Trends покрыты
  route/domain tests; пароль реального аккаунта не менялся.
- Gate 7: desktop 1440×900 и mobile 390×844 проверены во встроенном браузере для публичных
  и честных unavailable states; keyboard paths проверены для auth/tabs/dialog controls.
- Gate 8: migration policy проверяет additive transactional SQL. Все 14/14 миграций применены
  дважды к одноразовой legacy-fixture DB; текущая DB не затрагивалась. Финальные проверки:
  `npm test` — 92 файла/525 тестов; `npm run test:e2e` — 3 mocked critical-journey
  contracts; ESLint, TypeScript, worker/scripts syntax и `git diff --check` — pass;
  два последовательных `next build --webpack` — pass (101 routes/pages generated).
