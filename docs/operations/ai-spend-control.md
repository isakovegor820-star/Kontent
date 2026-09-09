# AI monetary admission and reconciliation

`ai_usage` is the refundable product allowance. `ai_spend_attempts` separately records every paid external attempt, including retries, fallbacks, semantic checks, classification, Sites, media, transcription and cloud embeddings. Refunding the product allowance never refunds this ledger. Local Ollama calls have no provider monetary charge and continue without monetary configuration.

Before enabling paid models, the operator must supply accepted positive integer budgets in **microUSD** (one USD = 1,000,000 microUSD):

- `AI_SPEND_USER_DAILY_MICROUSD`
- `AI_SPEND_PROJECT_DAILY_MICROUSD`
- `AI_SPEND_GLOBAL_DAILY_MICROUSD`
- `AI_SPEND_USER_CONCURRENCY`
- `AI_SPEND_PROJECT_CONCURRENCY`
- `AI_SPEND_GLOBAL_CONCURRENCY`
- `AI_SPEND_TARIFFS_JSON`: object keyed by the exact `provider/model` used at the paid boundary. Each entry contains nonnegative integer `inputMicrousdPerMillionTokens`, `outputMicrousdPerMillionTokens`, and optional `unitMicrousd`. At least one rate must be positive. Unknown model, missing rates or budgets rejects the call before contacting the provider.

Text provider keys use the engine ID (`navy-deepseek-pro`, `navy-deepseek-flash`, `navy-gpt-5-4`, `navy-qwen-3-6`, `navy-minimax-m3`, `openai`, `claude`, `gemini`) and the effective configured model. Cloud embeddings use `openai-embedding/<EMBED_CLOUD_MODEL>`; transcription uses `openai-transcription/<model>` or `navy-transcription/<model>`; generated media uses `navy-media/<model>`.

For media, `unitMicrousd` must cover the **maximum per-generation price of every enabled parameter combination for that model** (image quality, size, video duration, provider multipliers and taxes if charged). The reservation multiplies this bound by requested output count. Transcription units are rounded-up audio seconds, with a conservative 600-second bound if duration metadata is absent. Review provider-native account limits as a second monetary barrier; configuration here cannot prove the provider's own billing or token limit semantics.

Budgets apply to requests admitted during a UTC calendar day. A short PostgreSQL advisory transaction lock serializes user/project/global budget and concurrent request checks across processes. The reservation uses a conservative UTF-8-byte input bound plus framing overhead and the exact requested output limit. Known provider token usage replaces the bound; partial/aborted/truncated/unparseable responses without reliable usage keep the full bound. An unexpectedly larger actual usage is retained, so further admission sees the overrun; it is never rounded down to make the ledger look balanced. The operator must validate that configured provider/model limits and framing bounds cover billable reasoning and other hidden units before release.

Concurrency tracks live provider requests. The ten-minute reservation lease exceeds the bounded provider HTTP calls; expiry frees concurrency only. Reserved money survives process death, lease expiry, database restore, product quota refunds and new idempotency keys. Successful terminal replay performs neither another provider call nor another spend reservation. A media job accepted by its provider retains the full monetary bound when subsequent polling fails; free status polling does not create charges.

Attribution comes from the request's selected project and current member, or from a durable background operation. Sites regeneration persists its requesting member; reports persist theirs; manual probes and plans carry the authenticated requester in their queue job. Scheduled work uses the persisted project/site/source owner. Revoked attribution, role demotion without the operation permission, or an archived project blocks admission. The web and worker share the same role matrix; generation requires `content.create`, while the bot audience reply uses `audience.reply.send`; there is no fallback to another active project or member. Legacy Radar jobs resolve their existing explicit channel; jobs without any attributable project cannot call a paid provider. Shared public-corpus maintenance additionally needs explicit `AI_SPEND_SYSTEM_USER_ID` and `AI_SPEND_SYSTEM_PROJECT_ID` with current membership; its spend counts toward the same global cap. These identifiers have no defaults.

`src/e2e/fixtures/ai-spend-env.mjs` supplies synthetic amounts for disposable fake-provider runs. It is not production pricing or budget approval and must not be copied into production configuration.

## Read-only reconciliation package

1. Obtain owner-approved budgets/concurrency, current tariffs for every enabled model/parameter, billing timezone and rounding conventions, and provider-native account limits. Record who approved them and the provider tariff evidence. No approved values are supplied by this change.
2. Before a paid controlled run, apply the reviewed environment to staging and validate the active membership used for each test. Use explicit staging connections and a separately approved capped provider account.
3. Request one success, one paid partial/abort, one fallback, one rejected quality result, one media job, one embedding and one transcription. Capture safe request IDs, provider invoices/usage exports and ledger aggregates for the same billing interval. Do not treat missing usage as zero cost.
4. Normalize the provider export into a JSON array of `{ "date": "YYYY-MM-DD", "provider": "engine-id", "model": "effective-model", "billedMicrousd": "integer" }` aggregates. Use the admission UTC day only after accounting for the provider's own timezone/cross-midnight allocation.
5. Run `node scripts/report-ai-spend.mjs --database-url "$APPROVED_READONLY_DATABASE_URL" --date YYYY-MM-DD --provider-billing /absolute/path/provider-billing.json --output /absolute/path/reconciliation.json`. The script never reads `.env`, uses a read-only transaction default and exports no prompts, tokens or user emails. It reports absent billing, unexplained provider charges, mismatches and unknown attempts separately. Unknown attempts remain unresolved even if an aggregate falls below the reserved bound.
6. Investigate each mismatch or projection overrun, update reviewed configuration if warranted, rerun directed tests and obtain product/SRE acceptance. Do not reset the ledger or refund unknown attempts to regain capacity. Admission can be stopped by removing paid provider keys or stopping the relevant isolated workers; terminal replay and operator reconciliation stay available.

Local PostgreSQL and fake-provider tests establish admission and persistence invariants. Actual monetary correctness, accepted budgets, live alert receipt and provider billing reconciliation remain external release prerequisites.

## Local policy errors in interactive generation

A denied monetary reservation has not contacted the provider. The generator preserves this distinction through orchestration and the UI: it does not select a fallback model or record a provider outage for an `AiSpendError`. A half-open health-check permit is released without adding a provider failure.

| Public code | Meaning | Error status / recovery |
| --- | --- | --- |
| `ai_spend_cap_exceeded` | The requested conservative bound would exceed a user, project or global daily cap, including retained unknown spend. | 429; retry the same key explicitly after the limit resets or an approved policy change. |
| `ai_spend_concurrency_exceeded` | The applicable number of live provider reservations is exhausted. | 429; retry the same key after current work finishes. |
| `ai_spend_configuration_required` | Budgets or the exact provider/model tariff are missing or invalid. | 503; have the operator correct the configuration, then explicitly retry the same key. |
| `ai_spend_scope_required`, `ai_spend_invalid_projection` | Server attribution or the conservative projection is invalid. | 503; operator investigation is required before retry. |
| `ai_spend_scope_forbidden` | The initiating member no longer has the required current access. | 403; no model call or private result is returned. Restore access only through the normal authorized workflow. |

For an already-open interactive stream, HTTP remains 200 and these statuses appear in the terminal NDJSON `error.status` field with the exact code. They must not be counted as HTTP 502 provider outages. A policy-denied attempt can be retried with its existing key after policy permits because no provider request began. That recovery eligibility does not enable automatic model fallback. The server checks current authorization and monetary admission again on every retry. An actual consumer-cancelled or unconfirmed provider operation follows the separate durable-terminal rule: its old key cannot start fresh work, and the user must explicitly start a new operation.

The UI names exhausted spend capacity, concurrent work or incomplete configuration directly and preserves the draft. It does not claim that the provider is offline, that an unknown attempt was free, or that changing models bypasses the project budget.
