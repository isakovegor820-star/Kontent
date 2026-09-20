<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Local development runtime invariant

- Start the local application with `npm run dev` from this repository. This command must run
  both the Next.js web process and the full BullMQ worker.
- Do not report the dev environment as ready when only the web process is running. Autopilot,
  RSS, analytics, reconnaissance, media jobs, and scheduled publications require the worker.
- `npm run dev:web-only` is reserved for explicitly requested isolated UI work. Never use it
  as the normal local dev command.
- Before testing Autopilot, verify that the dedicated BullMQ `autopilot-plans` queue reports
  at least one worker. The `stats` queue is no longer its execution path.

## Production deploys

- Never ask the user for SSH host, password, or keys.
- Record the exact target SHA once the requested changes are merged. Wait for the
  successful `CI` / `build` aggregate for that SHA; it includes server/migration
  checks, production build, Trends hydration and all three browser engines.
- Do not change the target merely because another task advances `main`. Do not
  expand a release into fixing unrelated changes that arrived after that target.
- First inspect existing `Deploy production` runs. Their title is `Deploy <full SHA>`.
  Automatic deployment follows successful main CI when `AUTO_DEPLOY_ENABLED=true`.
  Watch an existing queued/running release with `gh run watch <run-id>`; do not
  dispatch a duplicate or cancel a healthy deployment.
- When no matching automatic release exists, or after correcting a demonstrated
  failed precondition, deploy only via
  `gh workflow run "Deploy production" --ref main -f target_sha=<full-SHA>`.
  Watch that exact run. Never use a moving branch name as the application target.
- The workflow skips already installed versions and candidates superseded by
  production. Report that decision accurately instead of claiming a new install.
  Completion means the target (or a verified descendant containing it) is healthy
  in production; a newer unrelated main CI is not a reason to prolong this task.
- Unchanged schema/migration/deploy files are verified automatically. Changed
  boundaries still require a rehearsed exact `SCHEMA_ROLLBACK_AUDIT` current:target
  pair. Never just update the variable to silence the gate. The server rechecks
  the expected current SHA under its deploy lock before any release mutation.
- Report the stages separately: CI, artifact build, server installation and
  production verification. Preserve the actual run IDs and measured durations.
- Server credentials already live in the GitHub environment `production`.
- Do not print secrets or `.env.production`.
