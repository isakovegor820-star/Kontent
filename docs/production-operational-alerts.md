# Production operational alerts

Aurora writes critical recoverable failures as one-line JSON records prefixed with
`[operational_signal]`. The JSON has a stable `marker=aurora_operational_signal`,
`schemaVersion=1`, an allow-listed event name, severity and only non-secret identifiers.

Configure the deployment log platform to parse the JSON suffix and create these alerts:

| Event | Trigger | Urgency | Runbook action |
| --- | --- | --- | --- |
| `recovery_failed` | any record | page immediately | Check database readiness and worker connectivity; do not retry quarantined sends manually until storage is healthy. |
| `delivery_unknown` | any record; group by `projectId` and `surface` | page during staffed hours | Open the audience inbox and resolve whether Telegram accepted the message before allowing a retry. |
| `telegram_rejected` | 3 records in 5 minutes per project, or 10 globally | warning | Verify bot permissions, business connection and Telegram status. |
| `upload_busy` | 10 records in 5 minutes, sustained for 10 minutes | warning | Inspect memory/CPU pressure and request rate before increasing the concurrency budget. |

Recommended notification payload fields are `event`, `severity`, `component`, `surface`,
`projectId`, `entityId`, `count`, `requestId` and `occurredAt`. Never attach raw request
bodies, Telegram tokens, message text, uploaded bytes or exception messages.

The application intentionally does not call an arbitrary alert webhook: outbound alert
delivery belongs to the deployment log/monitoring platform, where endpoint allow-lists,
retry policy and credentials can be managed independently from the web and worker runtimes.

`npm run test:deployment-smoke` is a point-in-time release gate, not a replacement for
continuous alerting. It proves that the deployed process, dependencies and CSP are ready at
the time of the check; the log platform must still page on later `operational_signal` records
and on sustained readiness failures.
