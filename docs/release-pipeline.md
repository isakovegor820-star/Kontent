# Production release pipeline

## CI

Every PR and main candidate keeps the full checks. Independent jobs run in parallel:

- `checks`: dependency audit, lint, types, migration and integration tests, one production build, unit tests and critical contracts.
- `e2e-build`: one production-mode E2E build, without connecting to PostgreSQL or Redis. Its archive retains the input digest and is scoped to this workflow run and commit.
- `e2e (chromium/firefox/webkit)`: three independent runners, each with its own PostgreSQL and Redis services. All restore the same E2E build and verify its source digest. Fixed test ports and identical build flags make the shared artifact compatible across those runners.
- `trends-hydration`: a separate production build and Chromium hydration test, isolated from the other fixtures.
- `build`: the existing required check name. It runs even after dependency failure and succeeds only when every branch succeeds. Skipped and cancelled jobs fail this aggregate.

Only replaced PR runs are cancelled. Main runs retain evidence for pinned release candidates. Failed browser jobs can be rerun without repeating the successful siblings. Test coverage, scheduled-publication timing checks, dependency audit and migration guards are not disabled. PR and main still both receive complete CI; using a PR result for a different merge SHA is not allowed.

The E2E artifact is not a production artifact. Its fake providers, experimental routes and public URL differ from production. Production is still built with the exact release SHA and the protected public build configuration. The redundant second generic CI build is removed; the dedicated manual E2E stability workflow remains available.

## Release ownership and identity

Record the target SHA after merge and keep it fixed. Later changes in main belong to later releases. After green CI, use the matching automatic `Deploy <full SHA>` run. Dispatch manually only if there is no matching active run, or after fixing a failed release precondition:

```sh
gh workflow run "Deploy production" --ref main -f target_sha=<40-character-commit-SHA>
gh run watch <run-id>
```

The workflow validates an exact commit on main, checks the latest GitHub Actions checks for that commit and reads current production under verified SSH identity. It does not redeploy an identical SHA or downgrade production to its ancestor. A superseded candidate is a no-op, not a new installation.

The release decision compares all SQL plus the schema, migration and deployment tooling between current production and the target. When the boundary is unchanged, a stale global audit string no longer blocks the release. If it changed, an externally rehearsed exact `current:target` attestation remains required. Missing evidence fails closed. New main commits do not alter the selected target or its evidence.

Deployment orchestration is copied from the trusted workflow commit before checking out the pinned application version. The server checks `AURORA_EXPECTED_CURRENT_SHA` under its deploy lock before cleanup/install/migrations. The source bundle retains history so ancestry and rollback comparisons are based on real commits. The final verification checks the exact production SHA, service readiness and the new worker's Telegram heartbeat; failures retain the existing rollback path.

## Verification and rollout

Release tests exercise real temporary Git histories: duplicate and superseded releases, moving main, diverged production, edited migration SQL, changed deployment tooling, stale attestations and missing manifests. A shell test verifies the stale-current guard runs before release writes. The actual aggregate CI script is exercised with failed, missing, skipped and cancelled dependencies.

The first release of this pipeline changes deployment tooling itself, so its rollback boundary intentionally requires an exact audit. Do not bypass that first gate. Compare timings from the new PR/main workflows and deploy with the prior baseline (roughly 27–35 minutes per CI, around 5 minutes per deploy). Parallelism reduces elapsed time, not necessarily total billed runner minutes; artifact transfer and available runner slots also affect the result.
