import { spawn } from "node:child_process";
import {
  assertRuntimeSchemaReady,
  safePreflightFailure,
} from "./runtime-schema-preflight.mjs";

// Production entrypoint for a single long-lived container. Aurora is two processes:
// Next serves HTTP, worker.mjs publishes scheduled posts and consumes background jobs.
// If either process dies, stop the other so the platform restarts the whole healthy unit.
const children = new Set();
let stopping = false;

function stop(signal, exitCode) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) child.kill(signal);

  const force = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 10_000);
  force.unref();
}

function start(label, args) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("error", (error) => {
    console.error(`[start] ${label} не запустился:`, error.message);
    stop("SIGTERM", 1);
  });
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    console.error(`[start] ${label} остановился (${signal || code || 0}); завершаю второй процесс.`);
    stop("SIGTERM", code || 1);
  });
}

process.once("SIGINT", () => stop("SIGINT", 130));
process.once("SIGTERM", () => stop("SIGTERM", 143));

try {
  await assertRuntimeSchemaReady();
} catch (error) {
  console.error("[start] runtime preflight failed", safePreflightFailure(error));
  process.exit(1);
}

start("worker", ["worker.mjs"]);
start("web", ["node_modules/next/dist/bin/next", "start", ...process.argv.slice(2)]);
