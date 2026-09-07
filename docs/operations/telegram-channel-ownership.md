# Telegram channel ownership verification

The API requires the caller's linked private Telegram account (`users.tg_chat_id`), established by the existing one-time bot/account handshake. It never accepts an actor ID from the browser. Before binding, Telegram must confirm a channel, the bot's explicit `can_post_messages: true`, and the linked human's current creator/admin publish rights. Read-only provider checks share an 8-second deadline; cancellation and malformed/network/provider errors cannot be mistaken for denied membership.

The persistence transaction consumes one proof bound to user, project, actor and channel, rechecks current project ownership and the linked actor, and retains the existing advisory lock and unique active-channel guard. A proof expires after five minutes. Telegram membership event IDs cannot be reused.

Account block applies to interactive bot access and both private-chat link flows as well as web sessions. A blocked actor cannot read the selected project through the bot, create a channel proof or consume an earlier proof. Final binding locks the current actor, member and project: a block/archive committed first denies admission; a change arriving after admission waits for that transaction. Unblocking restores legitimate access subject to the same live permissions and token expiry checks.

All browser picker launches use a fresh one-time `/start` link that captures the browser's authorized project. The bot binds its native picker intent to that project before displaying the picker. Telegram's `startchannel` URL does not echo a nonce: an unexpired pending picker therefore cannot be silently redirected to another project. Complete the first attempt or wait five minutes. Old and unlinked events do not create channel bindings. The live current rights check never falls back to a historical membership event when Telegram is unavailable.

## Existing connections

No migration changes a channel's owner or automatically republishes/reconnects it. Start with a read-only inventory:

```sh
TELEGRAM_OWNERSHIP_AUDIT_DATABASE_URL='<explicit authorized database URL>' node scripts/audit-telegram-ownership.mjs
```

The script starts a read-only transaction, prints IDs and verification metadata, and does not call Telegram, create jobs, or expose handles, private content or credentials. Run only against a database the operator is authorized to inspect. A missing proof means confirmation is required, not that the connection was necessarily illegitimate.

For each `owner_confirmation_required` record, the responsible project owner confirms their private Telegram identity and invokes the existing connect flow in that exact project. The server rechecks both current Telegram permissions and records the proof. Review the inventory again. Disputed ownership requires human resolution with the channel's Telegram owner and project owners; do not perform a mass `user_id` backfill, change memberships, delete history or publish test content automatically.

A native picker may not emit a fresh membership update if the bot already has unchanged rights. In that case, use the authenticated handle-based connection verification in onboarding against the exact project; do not remove and re-add a production bot automatically. Real Telegram client/picker behavior remains part of the separately authorized sandbox acceptance.

## Failure handling

- `telegram_identity_required`: link the private Telegram account first.
- `telegram_actor_not_admin`, `not_admin`, `not_channel`, `no_access`: correct the identity/target or missing explicit rights.
- `provider_timeout`, `provider_unavailable`, `provider_invalid_response`: temporary provider verification failure; no channel is saved. Retry deliberately.
- `provider_rate_limited`: wait the returned `Retry-After` interval; no automated loop.
- `connection_expired`, `proof_invalid`: restart the one-time confirmation.
- `taken`: active ownership remains in its existing project. Resolve that connection explicitly first.

The 8-second provider deadline and five-minute intent TTL are implementation safety bounds, not agreed production latency SLOs. Product/SRE must accept measured behavior with live sandbox results before release.

Project notifications and signed Mini App overview obey the same current account/project restrictions; their read/send boundaries are covered by the [background notification contract](telegram-background-notifications.md). New discovery jobs carry the actor and captured project of the successful channel connection.
