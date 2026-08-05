import { spawn } from "node:child_process";
import {
  prepareDevelopmentRuntime,
  safeDevelopmentFailure,
} from "./dev-bootstrap.mjs";

try {
  process.loadEnvFile?.(".env.local");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const children = new Set();
let stopping = false;

function start(label, command, args, env = process.env) {
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    console.error(`[dev] ${label} stopped (${signal || code || 0}); stopping the other process.`);
    stop("SIGTERM", code || 1);
  });
  return child;
}

function stop(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
  const force = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 5_000);
  force.unref();
  process.exitCode = exitCode;
}

process.once("SIGINT", () => stop("SIGINT", 130));
process.once("SIGTERM", () => stop("SIGTERM", 143));

try {
  await prepareDevelopmentRuntime();
} catch (error) {
  console.error("[dev] запуск не удался", safeDevelopmentFailure(error));
  process.exit(1);
}

// Local development is always a complete runtime. Explicitly override an inherited
// publication-only/media-only mode: otherwise the website opens normally while Autopilot,
// RSS and analytics silently have no BullMQ consumer.
start("worker", process.execPath, ["--env-file=.env.local", "worker.mjs"], {
  ...process.env,
  AURORA_WORKER_MODE: "full",
});
start("web", process.execPath, [
  "node_modules/next/dist/bin/next",
  "dev",
  ...process.argv.slice(2),
]);
