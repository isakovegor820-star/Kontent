# Operational observation and release evidence

This candidate has durable delivery, spend and storage state, selected application alerts and an aggregate read-only snapshot. It does not yet prove complete production monitoring or receipt by an accountable on-call person. Owner-approved thresholds, recipients, deployment bindings and a controlled real notification rehearsal remain external release inputs.

## Read-only runtime snapshot

`GET /api/readiness` observes AI execution evidence without creating a generation.
A successful model catalogue or configured API key does not prove completion
health. After web restart, `aiReady` remains false with `ai_unobserved`; after
15 minutes, old evidence is stale. A normal authorized generation records its
outcome through the existing provider and usage guards. Its fresh success or
failure becomes observable on the next readiness request. This does not disable
generation entry points or their permission/spend checks. The admin AI section
also reads durable attempts, separately from the process-local circuit snapshot.

Synthetic paid readiness completions require an explicitly approved operational
budget and accounted execution path; polling this read-only endpoint must not
create them. No live synthetic completion is enabled by this release change.

Run only with an explicitly selected, preferably least-privilege read-only PostgreSQL connection:

```sh
node scripts/report-runtime-operations.mjs \
  --database-url "$APPROVED_READONLY_DATABASE_URL" \
  --window-minutes 60 \
  --ai-config-json /absolute/path/reviewed-ai-limits.json \
  --output /absolute/path/runtime-snapshot.json
```

The tool reads no `.env`, does not start workers, contact providers, inspect Redis or send alerts, and never resets/retries an operation. The observation window is a reporting interval, not an approved alarm threshold. The optional JSON file contains the exact `AI_SPEND_*` cap/concurrency/tariff variables described in [ai-spend-control.md](ai-spend-control.md). Only validated numeric limits and tariff counts appear in the report; unrelated fields and raw tariff/model keys are not printed. This reports the supplied file and explicitly does not claim that it matches every running web/worker process. Without it, AI limits are labelled unconfigured/invalid and cap comparisons return null. Stored monetary attempts remain observable.

Every database read runs inside one repeatable-read, read-only transaction. A five-second connection timeout, fifteen-second statement timeout and two-second lock timeout bound individual waits. Sections use savepoints, so a missing relation/column, insufficient permission or timed-out query is reported as unavailable while independent sections can continue. No unavailable query is represented by zero. Errors printed by the CLI use a fixed code allowlist, without database connection strings or exception messages. The snapshot includes no user emails, content, prompts, connection tokens, raw error descriptions or provider response payloads. New output files use mode 0600; retain them with normal operational evidence access controls.

| Section | Meaning and limit |
|---|---|
| Post delivery | Current quarantined, publishing, published-unverified, unresolved reconciliation and due scheduled/retry rows; oldest due age. Published-unverified is not necessarily unknown delivery. |
| Publication parts | Durable unknown/sending/failed/sent part counts; successful parts are not retry candidates. |
| Telegram update receipts and audience replies | Unknown/sending bot receipt states and audience unknown/admitted-without-terminal states. Counts describe related layers and must not be added as unique publication totals. |
| Sites delivery | Unknown publication outcomes, publishing/unverified states, unresolved reconciliation and recent authentication failures. No receipt does not prove absence of an external publication. |
| Connection authentication | Unavailable channel/Sites connection counts and recent provider-auth events. This is not a complete sign-in-failure series; that coverage is explicitly marked not observed. |
| Durable outboxes | Waiting/due/dispatching/expired-lease counts and oldest due age for publication, extras, exports, monthly regeneration, Studio render, review reminders and autopilot schedule outboxes. The snapshot does not enqueue them. |
| Durable queue jobs | Media, Radar and site-analysis rows awaiting confirmation or lacking a recent state update. This is database evidence, not live BullMQ/Redis queue depth or worker heartbeat. |
| AI monetary usage | Current UTC-day accounted cost and failed attempts; all-time unknown usage exposure, reserved/live/expired attempts and comparisons with supplied monetary caps. An expired reservation lease still consumes money. Unknown spend cannot be refunded merely to clear an alarm. |
| Media | Actual DB policy, durable aggregate usage counters, sum of stored asset byte sizes, scope counts at policy caps and object-orphan backlog. Policy absence is explicit. A byte scan can hit the statement timeout on a large deployment; retain that limitation rather than assuming capacity is healthy. |

Use capture timestamps and repeated observations to establish incident duration. The report is a point-in-time diagnostic, not a scheduler, metric storage backend, health verdict or delivery reconciliation tool. It does not expose arbitrary IDs to make monitoring payloads actionable; privileged application views and read-only operator investigation provide scoped context when required.

## Existing signals and alarms

[production-operational-alerts.md](../production-operational-alerts.md) documents the application log marker `aurora_operational_signal` and `recovery_failed`, `delivery_unknown`, `telegram_rejected`, `upload_busy`. `src/lib/operational-signal.mjs` allows those event names and emits bounded labels/counts. Deployment log collection, persistence, deduplication and an accountable receiver must be configured outside that emitter. Threshold recommendations in existing documentation are not evidence of owner approval or actual alert routing.

`src/lib/admin-alerts.ts`, `admin-alert-ledger.ts` and `admin-alerts-scheduler.ts` separately probe database, Redis/publication worker, Telegram polling and overdue publications. Existing code defaults are a five-minute polling interval, six-hour repeat period and five publications older than five minutes; actual `AURORA_ADMIN_ALERTS*` configuration can override or disable these. These are observed code defaults, not accepted SLOs or incident budgets. Migration `20261018_admin_alert_delivery.sql` persists failure/recovery generations and per-recipient receipts. Shared transactional transition identity and delivery compare-and-set prevent simultaneous web schedulers from dispatching the same recipient twice. Repeat cooldown begins only after confirmed delivery; explicit Telegram rejection retries on the next eligible tick with provider `retry_after`, preserving already successful recipients. HTTP success without a valid Telegram message receipt, lost response or lost receipt persistence remains unknown across restart, with no automatic resend. The complete response read has an absolute eight-second deadline. Missing recipients or an unknown/rejected send is not delivered notification evidence.

Delivery uses configured Telegram and the current admin allowlist with linked chat; an email-based grant requires matching verified mailbox evidence and blocked identities are denied again at claim. `AURORA_OUTBOUND_DISABLED=1` also holds alerts. The restore quarantine supersedes every incomplete notification, including events without delivery rows, and preserves unknown/sent receipts. Unchanged restored conditions do not recreate those old events. See the [admin runbook](../admin-operations-center-runbook.md) and [restore runbook](../production-delivery-recovery.md). This mechanism depends on PostgreSQL to authorize recipients and persist receipts; complete database or web-process loss must be covered by independent external monitoring. It cannot prove or deliver its own database-outage alert while that database remains unavailable.

## Local rehearsal evidence

The new `src/e2e/runtime-operations.integration.ts` uses only a guarded disposable local `aurora_operations_test` database. Its eight cases cover synthetic unknown sends at post/part/bot/audience/Sites layers; queue delay; connection auth error; monetary unknown/expired reservations and cap exposure; storage capacity; a synthetic resolved incident preserving accounted spend; repeated reports without mutation; missing-table isolation; and secret-canary exclusion. A deliberately write-performing SQL view is rejected by PostgreSQL with `25006`, proving database read-only enforcement while other sections still report. The final CLI JSON is checked separately for the secret canary.

```sh
MIGRATION_TEST_DATABASE_URL=postgresql://egor@127.0.0.1:57439/aurora_operations_test \
  npx vitest run --config vitest.integration.config.ts src/e2e/runtime-operations.integration.ts
npx vitest run src/lib/admin-alerts.test.ts
ADMIN_ALERT_TEST_DATABASE_URL=postgresql://egor@127.0.0.1:57439/aurora_operations_test \
  npx vitest run --config vitest.integration.config.ts src/e2e/admin-alert-recipient.integration.ts
ADMIN_ALERT_TEST_DATABASE_URL=postgresql://egor@127.0.0.1:57439/aurora_admin_alert_test \
  npx vitest run --config vitest.integration.config.ts src/e2e/admin-alert-delivery.integration.ts
```

The listed database/limits are disposable synthetic fixtures, not production configuration. Admin-alert unit tests exercise independent probe failure handling, semantic Telegram receipts and hung-body timeout. Nine delivery integration cases exercise actual scheduler ticks, failure retry, cooldown/recovery, partial-recipient success, concurrent web schedulers, restart after unknown, lost receipt persistence, outbound hold, restored events without receipts and last-moment recipient revocation. Recipient integration separately verifies an unverified/stale/blocked identity cannot receive the admin alert. These do not prove real message receipt, production log retention, paging escalation or recovery by an operator.

Evidence files under the implementation audit: `O04-snapshot-integration.log`, `O04-snapshot-cli.json`, `O04-snapshot-lint.log`, `O04-snapshot-typecheck.log`, and the parent's final admin-alert regression logs. The final implementation commit is the source version authority.

## Concrete remaining release package

1. Record the accountable on-call owner, roster/escalation route, approved alert destinations and the actual deployed scheduler/log collector configuration. Confirm recipient authorization without sending unsolicited real messages.
2. Measure a representative approved load window and assign thresholds/observation periods for readiness, queue age/size, stale workers, unknown delivery, auth failures, budget/usage, storage and cleanup backlog. Record approval; do not treat current defaults or local fixture values as that approval.
3. Wire the selected durable snapshot metrics and existing operational signals into the chosen deployment monitoring system. Validate query cost, partial/unavailable sections, scrape/collection failures and secret exclusion. Include live Redis/BullMQ depth and heartbeat plus sign-in failure coverage where currently absent.
4. With separately authorized staging connections and a verified fake or controlled receiver, rehearse dependency loss, recovery, uncertain send, auth revocation, approaching/exhausted AI/media limits and alert transport failure. Keep unknown delivery quarantined; recovery is not permission to resend. Record timestamps, actual alert receipt/acknowledgement, duplicate suppression and restoration evidence.
5. Obtain explicit authorization before a real notification test, production configuration change, paid provider call or data cleanup. A real on-call receipt and operator sign-off are still required for O04/O07. The local command and tests close the available tooling/evidence gap without claiming that these external steps happened.
