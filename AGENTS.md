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
- Before testing Autopilot, verify that the BullMQ `stats` queue reports at least one worker.
