# Autopilot: finish editing before delivering a plan

## Incident and cause

The September 8 production diagnostic confirmed the reported 28-post plan: 24 ready posts, three `too_short` drafts (741, 519 and 504 characters), and one `hook` violation. All four failed drafts had passed semantic verification, with no invented specifics. This supersedes the initial hypothesis based on an older incident involving an unsettled semantic checker. Diagnostic workflow: https://github.com/isakovegor820-star/Kontent/actions/runs/34236097961 . The read-only probe reported one `autopilot-plans` consumer.

Generation, progress and checkpoint reuse treated human-review drafts as deliverable. Selection could fill the target with those drafts, skip automatic recovery, and mark the build complete. The notification then evaluated automatic eligibility and reported the same drafts as blocked. Editorial scores did not reliably distinguish finished posts from drafts awaiting review.

## Resulting behavior

- Only reader-ready posts satisfy selection, build completion, progress and checkpoint reuse. Manual approval of existing review drafts remains a separate capability.
- A mixed candidate reserve cannot displace ready posts with high-scoring review drafts, including when filling a news quota.
- Internal recovery selects actionable failed indexes up to the publication deficit. Missing evidence elsewhere in the reserve cannot suppress an available rewrite. Existing retry limits, recovery limits, approval rules and scope guards remain in force.
- Rechecks resume from persisted text. A temporarily unsettled semantic check receives at most one additional check per assessment, with the same text/evidence and existing provider timeouts. Negative findings are not retried in search of a favorable verdict.
- The generator and editor receive consistent length instructions, aiming at the midpoint of the requested range. Hook repair preserves details in the body. Rewrites receive the actual assessed text and its measured length.
- Form normalization no longer pads a short post with generic reader questions. Source-footers are removed before validation, so the gate checks the reader-facing text.
- Notifications no longer label an incomplete plan as assembled or conflate every approval restriction with failed quality control.

No production plans were rewritten or approved during implementation. A future release does not retroactively regenerate the existing pending plan.

## Verification

- `npm test -- --reporter=dot`: 610 files, 3354 tests passed.
- New cross-module regression covers the production 24+4 shape, preservation of ready checkpoints, targeted repair indexes, incomplete progress despite a legacy `selectedCount=28`, reserve selection and final approval eligibility.
- New quality tests cover identical-payload semantic retry, bounded unresolved outcomes, no retry of a negative factual verdict, no filler padding, source-footer removal before validation, and length/hook rewrite instructions.
- After the final source-footer adjustment, 64 relevant tests passed across five files.
- `npm run lint`, `tsc --noEmit`, `node --check worker.mjs`, `git diff --check`, and `node scripts/check-test-focus.mjs` passed.
- `npm run build`: final production build passed. A targeted final ESLint pass also passed.
- Live generation with a real model, production deployment and regeneration of the existing 28-post plan were not performed. The assertions cover application behavior; they do not claim that every model will produce an acceptable first draft.

## Scope and Coverage

`better-interface`, quick mode. Scope: the Telegram notification and its progress/count contract. Stack: Node.js worker, pure shared modules, Next.js repair endpoint; native Telegram message and inline keyboard styling. No full web screen or visual redesign.

| Domain | Evidence inspected | Result |
| --- | --- | --- |
| Accessibility | Screenshot: readable action name, textual status independent of color | No actionable static finding; live keyboard/screen reader not verified |
| Layout | Screenshot: message followed by a separate approval button | Clear within the inspected screenshot; responsive behavior not verified |
| Writing | `worker.mjs:7774`, completion and progress regression | Misleading completion language and readiness mismatch fixed |
| Typography | Screenshot: full message and button label visible | Clear within the inspected screenshot; zoom not verified |
| Colors | Screenshot: status is expressed in text | No established color defect; numeric contrast not verified |
| UI | Native Telegram message and inline keyboard | No custom visual change; live interaction not verified |

## Findings

| # | Severity | Domain | Location | Before | After | Why |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | HIGH, fixed | Writing | `worker.mjs:7040`, `worker.mjs:7774`, `src/lib/autopilot-build-attempt.mjs:170` | Incomplete drafts filled the target and produced “План собран … заблокировано контролем” | Incomplete drafts remain in recovery; completion requires ready posts. Exceptional residual eligibility restrictions use “готовы к одобрению X из Y” with the relevant remaining count | Aligns the completion promise, progress and available action |

## Considered but Rejected

| Location | Candidate | Rejected because |
| --- | --- | --- |
| Telegram inline keyboard | Adjust font, color or corner radius | Native client styling is outside this fix; no causal visual defect was established |
| Quality gate | Treat advisory drafts as automatically ready or lower the length requirement | Would hide incomplete editing rather than meet the requested quality standard |

## Verdict

The actionable finding is fixed and covered by executable checks. This verdict covers the inspected screenshot and tested notification/progress contract; live Telegram behavior is explicitly outside the claimed coverage.

Approve
