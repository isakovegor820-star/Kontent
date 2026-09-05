# Production release: admin interface, 2026-09-05

The release is isolated from `24117aaee406686f8a006f3b2875bea6342c29a8` (production/main). It contains the reviewed admin screens, safe read-only connection/spend endpoints, date/count corrections and the shared modal focus dependency. Other unfinished authorization, worker, billing, migration and general-product changes in the shared audit checkout are excluded.

No migrations, schema manifest, runtime worker or deployment workflow changes are included. The schema and rollback participant match production: version `2026-10-10.110`, 112 migrations, no forward migrations. A new disposable database was bootstrapped from this exact release's schema and passed schema readiness.

Monetary AI accounting is a separate unfinished dependency. If `public.ai_spend_attempts` does not exist, the endpoint explicitly reports `availability: not_configured`; the screen explains that costs/reserves are unknown and links to actual generation counts in the overview. It never returns fabricated zero monetary totals. Existing ledger installations retain the full spend view. No financial tariff or budget is installed by this release.

## Validation before dispatch

- Local production build: passed, including complete TypeScript validation.
- Full ESLint: passed.
- Full unit/contract suite: 582 files, 3,119 tests passed.
- Browser: actual production build against the production schema with synthetic fixtures; expired session, ordinary login through a local development companion, explicit missing-ledger state, connection diagnosis and owner navigation. HTTP production mutation-origin enforcement remained enabled.
- Previous full six-domain interface review and screenshots: [review.md](review.md). Its earlier shared-checkout build failure does not apply to this isolated release.
- Database and worker code remain byte-identical to the current production rollback target; existing publication actions retain their existing backend contracts.

GitHub CI, production dispatch and post-deployment verification are recorded in the deployment response with immutable run links. Local screenshots contain synthetic fixtures only.
