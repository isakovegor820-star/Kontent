# Release readiness — 2026-08-26

## Вердикт: NO-GO / NEEDS FIXES

Код стабилизационного среза существенно усилен, но строгий gate из исходного задания не
пройден. Deploy этого working tree не разрешён. Ни один красный или непроверенный пункт
ниже нельзя трактовать как «допустимый риск» без отдельного решения release owner.

## Зелёные локальные доказательства

| Gate | Результат |
| --- | --- |
| Lint / TypeScript / diff | `npm run lint`, `npx tsc --noEmit`, `git diff --check` — pass. |
| Focus policy | Нет focused или skipped тестов. |
| Unit/contracts | 481 test file, 2541 test — pass. |
| Migration policy | 101 additive transactional migration — pass. |
| Migration integration | Legacy, partial и fresh PostgreSQL; replay/rollback/checksum fail-closed — pass. |
| Schema readiness | Legacy/partial/wrong checksum/full; до readiness нет worker side effects — pass. |
| Auth integrations | Registration и password recovery, включая epoch/session invalidation — pass. |
| Project collaboration | 6 PostgreSQL integration scenarios, включая invitation race и owner invariant — pass. |
| Publication operation/lifecycle | 5 operation + 8 lifecycle integration scenarios — pass. |
| Publication quarantine | 4 overdue quarantined, 1 future untouched, 0 duplicates — pass. |
| Production build | Два последовательных `next build --webpack`: 228 pages, pass. |
| Stable boundary | Experimental page → `307 /app/calendar`; experimental mutation API → `404 not_found`. |
| Browser smoke | Login → five-step onboarding → exact draft in Composer; reload recovery, inline error, Unicode/HTML-like text and idempotent retry verified. |
| Interface review | 320, 390, 768, 1440: no horizontal overflow/duplicate IDs; mobile action surface no longer covers editor; contrast token tests meet WCAG AA. |

## Release blockers

1. **Production-topology browser E2E is red.** Two attempts built and started real web +
   worker + PostgreSQL + Redis, but Playwright timed out opening the Chromium pipe after
   180 seconds (system Chrome and downloaded Playwright Chromium). No E2E assertion ran;
   this is an environment/gate failure, not a pass.
2. **Experimental routes remain in the production bundle.** Proxy/API are fail-closed and
   navigation is hidden, but the build still emits Studio, Autopilot, Growth, Radar, Trends,
   landing variants and their APIs. The explicit build-exclusion requirement is unmet.
3. **Project archive is not an end-to-end product scenario.** Reads exclude archived
   projects, but there is no stable user mutation/API/recovery path.
4. **Account controls are incomplete.** Password reset revokes all sessions atomically,
   but authenticated password change and explicit «выйти на всех устройствах» controls are
   absent.
5. **Dependency audit is not completed.** Sandbox networking failed; elevated execution
   was rejected because `npm audit` would disclose dependency metadata to the public npm
   advisory service without separate user authorization. No workaround was used.
6. **Browser matrix is incomplete.** Current Chromium production E2E, WebKit, Firefox,
   dynamic keyboard traversal, real screen reader, open mobile keyboard, reduced-motion
   emulation and 200% zoom are not all verified. Static semantics and contrast tests do not
   replace these checks.
7. **Load/recovery gates are absent for this RC.** No approved capacity profile, DB/Redis
   saturation result, large-project pagination target, backup restore rehearsal, deployment
   smoke or rollback smoke is attached to this working tree.
8. **Not every integration/fault-injection suite was rerun.** Critical auth, project,
   publication, migration and readiness integrations passed, but full AI, provider outage,
   Redis outage, DB timeout, slow-network and two-tab production-topology matrix is not green.
9. **Observability is partial.** Operational signals, readiness, heartbeat and alert docs
   exist, but an external dashboard/error tracker and proof that every UI→DB→job→provider
   path carries the requested correlation identifiers were not verified end-to-end.
10. **Technical monoliths remain.** Business helpers and workers have testable modules, but
    `worker.mjs`, Composer, Calendar and Store are not yet separated to the requested final
    boundaries. A big-bang rewrite is intentionally not part of this RC.

## Interface review (full workflow)

- Accessibility: semantic headings, labels, inline alert/focus, live save states, target
  sizing and reduced-motion branches inspected; dynamic keyboard/screen-reader matrix remains
  blocked as described above.
- Layout: onboarding and Composer checked at 320/390/768/1440. The mobile publication panel
  was moved into document flow; desktop focus clearance remains measured with ResizeObserver.
- Writing: experimental promises and unsupported networks removed from stable shell,
  onboarding, editor and settings; errors now state recovery and avoid false success.
- Typography: one visible H1 per reviewed screen, readable measure/wrapping, 16px mobile
  textarea to prevent iOS input zoom; no clipped text observed in reviewed viewports.
- Color: existing dark/light semantic token contrast tests are green; error/success states do
  not rely on color alone.
- UI polish: initial onboarding motion suppressed, reduced-motion respected, actions wrap,
  logical margins are used, and mobile navigation no longer competes with a fixed tall panel.

## Required next gate

1. Run `npm ci` and an authorized dependency audit in clean CI.
2. Exclude experimental route trees from the production artifact, not only runtime access.
3. Make the full production-topology E2E green in CI, then run Chromium/WebKit/Firefox and
   accessibility checks.
4. Close or formally remove project archive, authenticated password change and explicit
   all-session revoke scenarios.
5. Execute complete integration/fault-injection, load, backup restore, deploy smoke,
   readiness and forward-schema rollback rehearsal against one immutable target SHA.
6. Apply the existing production-readiness runbook and release only when every required
   check is green for that same SHA.
