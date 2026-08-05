# Second-round implementation checklist — Aurora — 2026-08-02

This file tracks only work performed for the second-round prompt. Existing dirty-worktree
changes predate this round and remain user-owned. Statuses mean:

- `reproduced`: the reported failure was independently demonstrated;
- `fixed`: implementation is present, but the gate is not complete until runtime evidence exists;
- `verified`: acceptance checks passed against production code and disposable infrastructure;
- `blocked`: completion requires an explicitly forbidden action or new user authority.

Baseline: branch `main`, HEAD `7e15ef0b3b9c9e4cf91571010a4b5b1b71d26f45`.
Baseline verification: `npm test` — 92 files / 525 tests passed; `npm run lint` — passed.
No persistent database, Redis state, live destination, or existing entity has been mutated.

| Gate | Defect / acceptance obligation | Baseline evidence | Status | Implementation / evidence |
|---:|---|---|---|---|
| 0 | Reachable legacy/partial DB is reported ready | DB probe is only `select 1`; empty AI provider list becomes `aiReady=null` without degradation | verified | exact schema manifest + catalog/checksum probe; legacy/partial/checksum disposable PostgreSQL acceptance passed |
| 0 | Worker starts consumers/heartbeat before schema compatibility is proven | BullMQ workers and queues are constructed at module scope before any schema gate | verified | preflight now precedes Redis construction; legacy fixture left 1/1 job waiting and heartbeat absent |
| 0 | Production start does not fail before traffic listener on schema mismatch | `scripts/start.mjs` immediately spawns worker and Next | verified | shared read-only preflight runs before both child spawns; no auto-migration path |
| 0 | Readiness must expose process, DB reachability, schema, Redis, worker, AI, mail separately | Current response conflates reachability and capability | verified | route/model tests cover 503 schema reason and degraded mail/unobserved AI; 16 targeted tests passed |
| 1 | Full worker immediately enqueues overdue scheduled posts | `reconcileScheduledPosts()` uses `Math.max(0, scheduled_at-now)` | verified | pre-consumer quarantine + claim cutoff + revision-bound jobs; disposable full-worker fixture created 0 overdue jobs |
| 1 | Startup must quarantine legacy overdue/manual/RSS work and preserve future schedules | No explicit eligibility/origin/review policy exists | verified | 4 origins quarantined with safe reason/summary; future row produced exactly 1 delayed job across two startups; Calendar exposes recovery action |
| 1 | Retry/backoff work must not be mistaken for overdue legacy work | Scheduled retry rows have no authoritative next-attempt gate in reconciler | verified | explicit `failed_retry` + `next_attempt_at`; future retry produced 0 jobs; claim/reconciler enforce the clock |
| 2 | Web Autopilot confirm is not bound to preview revision | Request carries plan/channel/idempotency key, not a revision token | verified | persisted opaque preview token + monotonic revision + canonical SHA-256 snapshot; confirm validates token/revision/hash/freshness and plan CAS before side effects; stale route test returns 409 |
| 2 | Edit/confirm and double-confirm must create zero stale jobs | No shared web/bot CAS contract | verified | web and bot use the same canonical hash and expected-revision claim; disposable PostgreSQL/Redis test covers draft/date/quality mutations, channel isolation, parallel claims and idempotency with 0 posts/outbox/jobs |
| 3 | Citation syntax can yield 100/100 for semantically false legal claims | Production fixture from post-fix audit passes with no blockers | verified | production `assessAutopilotDraft` strips citation syntax from entailment, rejects guarantee/universality/causality/obligation/outcome/risk expansions per claim, caps score below threshold; exact five-claim fixture produces five blockers |
| 3 | Automatic approval must require deterministic checks plus semantic entailment | Semantic verdict is not a mandatory auto-approval prerequisite | verified | Autopilot eligibility now requires complete claim verdicts with concrete source spans and semantic provenance; unavailable/timeout/unknown is `not_checked` and manual-only; disposable PostgreSQL/Redis scheduling attempt produced 0 posts/outbox/jobs |
| 4 | AI provider/orchestration/usage policies differ by surface | Studio, direct routes and worker use separate stacks | verified | shared engine/fallback policy and strict completion service now cover brief/profile/worker/semantic adapter; streamed Studio/Composer use the same provider policy and terminal contract; disposable PostgreSQL + fake-provider suite proved common Navy fallback and five exact provider inputs |
| 4 | Clean EOF without terminal marker can become postable | Studio/provider paths do not uniformly require terminal + validation markers | verified | SSE `[DONE]`, Anthropic `message_stop`, Ollama `done:true`, internal validation + done are mandatory; provider/route/client tests prove truncated result is refunded, previous text restored and never postable |
| 4 | `not_checked` may consume quota while hiding review actions | Reservation is committed although result is unusable in Studio | verified | complete `not_checked` remains visible/reviewable with copy/regenerate actions while schedule stays blocked; failure/truncation/cancel release exact reservation; real PostgreSQL race suite passed 6/6 |
| 5 | Failed offline draft revision exists only in React memory | Failed attempted revision is not durably retried after reload | verified | synchronous account/workspace/client-key scoped durable outbox precedes debounce; production-browser E2E aborted PATCH, hard-reloaded, recovered exact payload, synced once, and found exactly one PostgreSQL draft row |
| 5 | Multi-tab conflict and pending-revision recovery need browser evidence | Current tests do not exercise browser + PostgreSQL durability | verified | newer local payload wins display; base-version mismatch is explicit conflict and preserves both copies; 25 draft/API tests plus production browser/PostgreSQL persistence proof pass |
| 6 | Partial multi-destination retry can mix two draft revisions | Per-destination fingerprint replay is not operation-wide CAS | verified | immutable `publication_operations` snapshot + destination posts/outbox; disposable PostgreSQL suite proves partial A/B, stale 409/zero jobs, unchanged retry, parallel keys and ownership |
| 7 | Concurrent forgot requests can leave two active tokens | No user lock/generation uniqueness | verified | per-user locked reset generation + unique active token; concurrent disposable-PostgreSQL requests leave one valid generation and invalidate the first token |
| 7 | Login/reset race can preserve a session authenticated by old credentials | Sessions have no credential epoch | verified | session credential epoch is checked at creation and every lookup; password reset atomically advances epoch and deletes sessions; race suite proves no old-epoch session survives |
| 7 | Unconfigured delivery presents fake “sent” success and leaks timing | Mail is synchronous/optional while public response promises delivery | verified | honest equal-envelope public response; encrypted asynchronous outbox; slow fake mail no longer delays request, and readiness reports missing token/mail capability |
| 8 | Reconciler bypasses publication retry backoff | Pending/scheduled scan can enqueue before retry delay | verified | leased `publication_outbox` is the sole operation dispatcher; generic reconciler excludes its rows; real PostgreSQL proof: future retry 0 enqueue and parallel due reconcilers exactly 1 enqueue (5/5 integration suite) |
| 8 | Telegram media + long text stores only one external message ID | Aggregate publication has no durable parts model | verified | ordered `publication_parts` persist every ID/status; production multipart module proves media success + text 429 + retry sends only text; aggregate reconciliation checks every part and Calendar/API expose part truth |
| 9 | Demo coffee context leaks into real media generation | Global local seed supplies niche/tone | verified | media API accepts only an owned `channelId`, resolves context server-side before quota use, and stores the effective niche/tone; real E2E injected coffee client fields and PostgreSQL retained only the legal-tech profile |
| 9 | Trends explicit refresh is non-idempotent and hides HTTP errors | No operation key/in-flight contract | verified | persisted `trend_refresh_operations` owns idempotency/in-flight replay and honest HTTP errors; parallel same-key E2E produced one operation and channel A did not mutate channel B |
| 9 | “Weekly” analytics uses all-time cohort and overclaims from tiny samples | Query lacks period; insights lack minimum sample/confidence | verified | Moscow seven-calendar-day cohort, explicit sample/confidence and `<3` suppression; E2E excluded a 30-day 10,000-view post, returned 10 weekly views, and no actionable best time for one sample |
| 9 | Critical touch targets are smaller than 44×44 px | Shared `sm`, switch and checkbox dimensions are below target | verified | shared button/tabs/switch/checkbox hit areas corrected; browser at 390×844 proved no horizontal overflow and every inspected auth control at least 44×44; ArrowRight switched the focused ARIA tab |
| 10 | Existing “E2E” is mocked Vitest, not browser/HTTP/PostgreSQL/Redis | No deterministic real-infrastructure critical journey suite | verified | `test:e2e:real` runs production Next, disposable PostgreSQL/Redis, publication-only worker, fake AI/Telegram and Chromium; final journey passed drafts, mobile routes, media context, Trends, Analytics, truncated AI and multipart retry |
| 10 | CI does not exercise schema readiness, worker startup safety, or two builds | Workflow omits these release proofs | verified | CI now runs focus/skip gate, types, migrations/readiness/quarantine integrations, two consecutive builds, real browser E2E and failure artifact upload; mocked suite renamed `test:contracts` |

## Safety log

- Normal/full worker: **not started**.
- Persistent/live database migration: **not run**.
- Persistent Redis mutation: **not performed**.
- Telegram public action: **not performed**.
- Existing users/channels/posts/feeds/integrations/settings: **not changed**.
- QA entities: Gate 2 disposable user, two channels, plans and approval audit rows; all existed
  only inside the temporary `aurora_autopilot_cas_test` cluster and were removed with it.
- Gate 3 disposable QA user/channel/plan/operation existed only inside
  `aurora_semantic_gate_test`; the temporary PostgreSQL cluster and Redis queue were removed.
- Gate 4 disposable QA users and AI usage rows existed only inside `aurora_ai_gate_test`;
  the local fake provider and temporary PostgreSQL cluster were stopped and removed.
- Gate 6 disposable drafts/channels/operations/posts/outbox rows existed only inside
  `aurora_publication_gate_test`; the temporary PostgreSQL cluster was stopped and removed.
- Gate 7 disposable users/tokens/sessions/encrypted mail-outbox rows existed only inside
  `aurora_password_reset_gate_test`; the temporary PostgreSQL cluster was stopped and removed.
- Gate 8 retry/lease QA rows existed only inside a new `aurora_publication_gate_test` cluster;
  the cluster was stopped and its temporary directory removed after 5/5 tests passed.
- Gate 9/10 QA user, channels, profiles, drafts, analytics rows, refresh operation, AI usage,
  publication operation/outbox/parts and fake external IDs existed only inside the disposable
  `aurora_e2e_real` PostgreSQL/Redis harness. The harness flushed Redis, dropped the schema,
  stopped fake providers/workers and removed all temporary directories after success.
- The final Browser skill smoke used a production web process pointed at unreachable local
  dependency ports, submitted no form, created no entity, and was stopped after the read-only
  responsive/keyboard check.

All Gate 0/1 PostgreSQL clusters, Redis instances, queues and fixture rows were disposable
and were stopped/removed by their harnesses. No persistent QA entity remains.

## Final verification snapshot

- `npm run test:migrations`: 20 additive transactional migrations validated.
- `npm run test:focus`: no focused or skipped tests.
- `npm run lint`: passed.
- `npx tsc --noEmit`: passed.
- `npm test`: 102 files / 578 tests passed.
- `npm run build` twice consecutively after a clean stop: both passed, 102 routes, no lock.
- `npm run test:e2e:real`: passed against disposable PostgreSQL/Redis and fake providers;
  recovered one durable draft, created one Trends operation, calculated 10 weekly views,
  released one truncated AI reservation, persisted fake Telegram parts `701`/`702`, and
  retried only the text part (`sendPhoto=1`, `sendMessage=2`).
- In-app Browser smoke at 390×844: no horizontal overflow, auth targets at least 44×44,
  ARIA tab keyboard transition verified. No form was submitted.
