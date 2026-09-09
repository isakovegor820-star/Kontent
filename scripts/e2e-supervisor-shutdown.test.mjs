import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./start.mjs", import.meta.url), "utf8");
const supervisor = source.slice(source.indexOf("const children = new Set();"), source.indexOf("\ntry {"));

async function stopFixture(duplicate) {
  // Run the production supervisor's actual signal/child-management code, omitting
  // only schema preflight and real application startup. The one child is ours.
  const ownedChild = `let stopping = false; process.on("SIGTERM", () => {
    if (stopping) return; stopping = true; console.log("CHILD_STOPPING");
    setTimeout(() => { console.log("CHILD_DRAINED"); process.exit(0); }, 200);
  }); console.log("CHILD_READY " + process.pid); setInterval(() => {}, 1000);`;
  const runtime = spawn(process.execPath, ["--input-type=module", "-e",
    `import { spawn } from "node:child_process"; ${supervisor}\nstart("fixture", ["-e", ${JSON.stringify(ownedChild)}]);`,
  ], { env: {}, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(runtime, "exit");
  let output = "";
  let childPid;
  let readyResolve, stoppingResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const stopping = new Promise((resolve) => { stoppingResolve = resolve; });
  runtime.stdout.on("data", (chunk) => {
    output += chunk.toString();
    const match = output.match(/CHILD_READY (\d+)/u);
    if (match) { childPid = Number(match[1]); readyResolve(); }
    if (output.includes("CHILD_STOPPING")) stoppingResolve();
  });
  try {
    await ready;
    runtime.kill("SIGTERM");
    await stopping;
    if (duplicate) runtime.kill("SIGTERM");
    const [code, signal] = await exited;
    return { code, signal, output };
  } finally {
    runtime.kill("SIGKILL");
    if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* already exited */ } }
  }
}

describe("production supervisor graceful shutdown", () => {
  it("drains its child after one SIGTERM", async () => {
    const result = await stopFixture(false);
    expect(result).toMatchObject({ code: 143, signal: null });
    expect(result.output).toContain("CHILD_DRAINED");
  });
  it("keeps supervising the child when SIGTERM is forwarded twice", async () => {
    const result = await stopFixture(true);
    expect(result).toMatchObject({ code: 143, signal: null });
    expect(result.output).toContain("CHILD_DRAINED");
  });
});
