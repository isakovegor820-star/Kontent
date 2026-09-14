# Knowledge engine recovery — 2026-09-14

Knowledge imports previously depended on a legacy embedding key and rejected the cloud model's default output size. The revised embedder supports NavyAI and modern OpenAI configuration, explicitly requests 1024 dimensions, validates vectors, and reports safe failure codes. A live NavyAI request and full local indexing/retrieval smoke both passed (cosine similarity 0.7669 for the synthetic query).

Text indexing is committed before provider calls. Embedding failure leaves text available to lexical retrieval and generation. Retries retain chunk IDs, usage counters and expiry metadata. Automatic retries use persisted deadlines, at most five attempts and fair leased reconciliation; permanent failures require a manual retry or changed model. Model identities fence vectors in channel/site retrieval and the shared radar corpus. Legacy vectors remain stored while the worker rebuilds their index.

Explicitly imported channel examples now feed style context in Studio and Autopilot, independently of embeddings. They remain excluded from factual support. The knowledge screen separates text availability from semantic readiness, exposes recovery, announces status transitions and preserves unsaved form input on network failure. Admin diagnostics report index health separately from chat health.

The migration is additive. No knowledge source is deleted to recover an index. CI now runs the real PostgreSQL recovery and authorization scenarios.

## Verification

- Full Vitest suite: **3631 tests passed**, see `unit-tests.log` (a previous unrestricted parallel run exposed an unrelated existing Composer timing race; the bounded four-worker run passed).
- PostgreSQL integration: 22 tests passed across `knowledge-engine.integration.ts` and `knowledge-access.integration.ts`; retry limits, source 201, deletion during provider calls, stable chunk IDs, generation facts/style and revoked/cross-channel access.
- Live provider + database: `live-smoke.log`; genuine NavyAI calls with synthetic source data, then fixture cleanup.
- Browser: `browser-result.json`; real local web + BullMQ worker + isolated PostgreSQL/Redis and an HTTP provider fixture. Keyboard Enter on Retry reached the server, the worker indexed the source, and the page became ready without reloading. Desktop 1440 px and mobile 390/320 px, no horizontal overflow, no page errors.
- Production build: `build.log` passed. Migration policy, TypeScript and ESLint verified separately.

## Consolidated interface review — quick

Scope: the knowledge import, waiting, error and retry path, plus the shared admin diagnostic row. Existing Next.js/React, Tailwind and semantic tokens retained.

| Domain | Evidence | Result |
| --- | --- | --- |
| Accessibility | Browser keyboard retry, stable role=status, React interaction tests, existing field labels and invalid-field focus | No actionable findings in the changed flow; screen-reader hardware/software not exercised |
| Layout | Screenshots and runtime scroll measurements at 1440, 390 and 320 px | No horizontal overflow; retry remains reachable |
| Writing | Pending, text-ready, semantic-ready, paused and retry messages | False time guarantee removed; cause and next action displayed |
| Typography | Wrapped status/cause text and controls in desktop/mobile screenshots | Existing scale preserved, no clipped recovery text |
| Colors | Runtime status text rgb(52,64,84) against rgb(244,247,253) | Contrast 9.75:1; status also has text meaning |
| UI | Actual error → keyboard retry → worker completion → ready transition | No indefinite spinner for quarantined failure; active attempts remain observable |

Considered but rejected: rewriting mobile Tabs (existing local horizontal scrolling works); changing shared card/token styling (no evidence of a defect in the changed flow); treating imported style as factual support (would break the factual boundary).

Remaining verification boundary: dark appearance and assistive-technology speech output were not separately exercised. No visual redesign or broad interface certification is claimed.

Verdict for the inspected primary path: **Approve**.

## Runtime configuration

NavyAI is selected automatically when no OpenAI embedding key is configured and NAVYAI_API_KEY is present. EMBED_PROVIDER explicitly overrides selection. EMBED_API_URL/EMBED_API_KEY provide dedicated configuration. No production credential change is required for the observed Navy-only environment.

After rollout, the full worker's startup/cron reconciliation must process legacy sources. Check the separate knowledge_index diagnostic and the aggregate knowledgeIndex production diagnostic. Text availability, embedding errors and last successful indexing must be inspected independently.

Release status: validated locally; no GitHub publication or production deployment has been performed.
