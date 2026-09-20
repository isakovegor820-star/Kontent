# Telegram background notification delivery

Background project notifications require an explicit project and stable event identity. `notifyUser` checks the recipient's current membership, account block, archived project, bot controls and project notification preference, then checks them again after the durable claim immediately before the provider call. It never resolves the data boundary from a mutable selected-project preference. All current roles with project read access may receive the project's enabled notifications. Signed Mini App requests also recheck account and project access before returning their output.

Migration `20261020_telegram_background_delivery.sql` adds `telegram_background_deliveries`. Its identity is `(project_id,user_id,event_key,part_index)`; bot, chat and exact rendered request hash are bound to that identity. The journal does not store a bot token or notification body. This journal is independent of Telegram update IDs and Redis retries. Background transport does not consume the interactive update part counter.

| State | Meaning and permitted behavior |
| --- | --- |
| `sending` | Claim persisted before dispatch; a process may have sent the message. A new process holds it as unknown. |
| `sent` | A valid Telegram `ok:true` response with a positive message ID was durably saved. Reuse its receipt; never send this part again. |
| `rejected` | Valid `ok:false` with provider error code. Only transient 429/5xx may retry, after the saved deadline and with the same bot, chat and request hash. |
| `unknown` | Response/receipt was lost or malformed. No automatic resend. |
| `cancelled` | Current permission/preference failed after the claim and before transport. No provider request was made. This event stays cancelled. |

The worker contract is `true` for confirmed delivery, `false` for a proved denial/rejection and `null` for uncertainty. A successful HTTP response without a semantic message receipt is unknown. If the database loses the acknowledgement after the provider sent, the original `sending` fence remains. A changed payload or destination for the same event also holds; it never silently becomes a new send.

Event keys use the persisted cause: publication ID plus schedule revision and outcome, gap-question ID, content-idea ID, autopilot-plan ID, post/result window, recipient/project/local digest date and kind, stats report job ID, review-reminder job key, or niche alert and matched post ID. Unknown daily/weekly delivery retains the digest claim and is excluded from confirmed counts. A report job stops automatic retry on unknown. Review reminders retain `delivery_unknown`; gap questions remain pending. Confirmed niche candidates are marked only after `true`; older unknown batches are not marked by a later successful batch.

## Recovery and rollout

Apply the additive migration before starting the new worker. It does not invent historical receipts or replay past notifications. Preserve the ledger across upgrades and restarts. Restore quarantine converts incomplete `sending`/`rejected` entries to `unknown`, preserves `sent`/`unknown`/`cancelled`, and keeps global outbound hold enabled. The [publication recovery runbook](../production-delivery-recovery.md) still governs any production resume.

For an incident, collect the safe event identity, bot/chat IDs, state, message IDs and timestamps through an authorized read-only connection; exclude message bodies and credentials. Reconcile with the exact receiving chat using separately authorized access. An absent message in search is not proof that no send happened. Do not delete or reset a receipt to make a job pass.

Transient rejected digests/reports use their existing scheduler/job retries after the persisted deadline. Some one-time causes (for example a niche match already inserted or a terminal publication notice) have no recurring automatic caller; their rejection is retained for inspection. Replaying such a notification requires an explicit operational action against the same durable event and identical payload after checking the provider's definite rejection and current authority. No automatic general replay endpoint was added. A permanent rejection requires fixing its cause and an explicit reviewed decision; an unknown event cannot use this rejection path. If there is no independent receipt proving delivery or non-delivery, preserve uncertainty and agree any distinct new send as a separate external action.

Local fault tests use a disposable database and fake provider receipts. Real receiver confirmation, on-call ownership, independent monitoring and live Telegram behavior remain the separately authorized O04/O05 acceptance steps.
