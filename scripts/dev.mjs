import { spawn } from "node:child_process";

const children = new Set();
let stopping = false;

function start(label, command, args) {
  const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
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

start("worker", process.execPath, ["--env-file=.env.local", "worker.mjs"]);
start("web", process.execPath, [
  "node_modules/next/dist/bin/next",
  "dev",
  ...process.argv.slice(2),
]);

