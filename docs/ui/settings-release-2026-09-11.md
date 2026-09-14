# Settings release readiness — 2026-09-11

The user authorized production deployment of the Settings UX fixes. This release starts from verified production/main `fc47f88594ffe0047b4a682974003b01bcfeb11c` and contains only the settings change scope, its tests and documentation. The original audit checkout remains untouched by release preparation.

The patch was reconciled with newer production work: the current writing rules/templates tabs, domain verification guide, project invitations and directly editable Autopilot controls are retained. Search selects the appropriate writing tab. Account-only autosave uses the production application's native fetch convention. Existing production browser tests now cover profile autosave, instant theme changes, persisted appearance, stationary search and exact UTM navigation; role changes include their new explicit confirmation.

Local release validation:

- `npm test`: 620 files / 3458 tests passed.
- Focused settings and component suite: 39 files / 167 tests passed.
- `npx tsc --noEmit --incremental false`: passed.
- `npm run lint`: passed.
- `node --check scripts/test-e2e-real.mjs` and `git diff --check HEAD`: passed.

Read-only production audit run `34585994044` confirmed the expected production SHA, active web and worker services, and successful health response. Database schema, migrations and migration runner are identical to that production baseline. Forward deployment and rollback therefore use the same schema and migration set. The exact current:target rollback variable must be set after the release target is known; no schema safety gate is bypassed.

GitHub CI must succeed before production dispatch. Deployment runs only through the existing `Deploy production` GitHub workflow; its readiness checks and rollback remain enabled. Final run IDs and post-deployment checks are recorded in the task delivery report.
