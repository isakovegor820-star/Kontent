<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
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
- Deploy only via `gh workflow run "Deploy production" --ref main` after CI is green.
  Watch the run with `gh run watch`.
- Server credentials already live in the GitHub environment `production`.
- Do not print secrets or `.env.production`.
