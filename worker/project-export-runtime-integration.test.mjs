import fs from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { CRON_SCHEDULES } from "./cron-schedules.mjs";

const source = fs.readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");
const parsed = ts.createSourceFile("worker.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function findNode(predicate) {
  let found;
  const visit = (node) => {
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!found) throw new Error("Actual worker cron boundary missing");
  return found;
}
const registration = findNode((node) => ts.isForOfStatement(node) && node.statement.getText(parsed).includes("cronQueue.upsertJobScheduler"));
const startup = findNode((node) => ts.isForOfStatement(node) && node.statement.getText(parsed).includes("cronQueue.add"));
const cronQueueDeclaration = findNode((node) => ts.isVariableDeclaration(node) && node.name.getText(parsed) === "cronQueue");
const cronWorker = findNode((node) => ts.isNewExpression(node) && node.expression.getText(parsed) === "Worker" && node.arguments?.[0]?.getText(parsed) === '"cron"');
function run(statement, bindings) {
  return new Function(...Object.keys(bindings), `return (async () => { ${statement} })();`)(...Object.values(bindings));
}
async function registeredJobs(mode = {}) {
  const cronQueue = { upsertJobScheduler: vi.fn(async () => {}), add: vi.fn(async () => {}) };
  const flags = { AUTOPILOT_ONLY: false, MEDIA_ONLY: false, PUBLICATION_ONLY: false, ...mode };
  const registeredQueue = await run(`return ${cronQueueDeclaration.initializer.getText(parsed)};`, {
    ...flags, connection: {}, Queue: class {
      constructor(name) { expect(name).toBe("cron"); return cronQueue; }
    },
  });
  await run(`${registration.getText(parsed)}\n${startup.getText(parsed)}`, {
    cronQueue: registeredQueue, CRON_SCHEDULES, ...flags,
  });
  return cronQueue;
}

describe("project export worker runtime wiring", () => {
  it("runs only in full worker mode and closes every export resource", () => {
    expect(source).toContain("createProjectExportWorker({ connection, pool, concurrency: 1 })");
    expect(source).toContain("new Queue(PROJECT_EXPORT_QUEUE, { connection })");
    expect(source).toContain("await projectExportWorker?.close()");
    expect(source).toContain("await projectExportQueue?.close()");
  });

  it("reconciles durable ownership at startup and every minute", async () => {
    const scheduleImport = findNode((node) => ts.isImportDeclaration(node) && node.moduleSpecifier.text === "./worker/cron-schedules.mjs");
    expect(scheduleImport.importClause.namedBindings.elements.some((item) => item.name.text === "CRON_SCHEDULES")).toBe(true);
    expect(source).toContain("reconcileProjectExportOutbox({");
    expect(source).toContain("expireProjectExportArtifacts(pool, 500)");
    const queue = await registeredJobs();
    expect(queue.upsertJobScheduler.mock.calls.filter(([name]) => name === "exports")).toEqual([
      ["exports", { pattern: "* * * * *", tz: "Europe/Moscow" }, { name: "exports" }],
    ]);
    expect(queue.add.mock.calls.map(([name]) => name)).toEqual([
      "stats", "recon", "trend", "today-opportunities", "knowledge-index", "discover", "exports",
    ]);
    expect(queue.add).toHaveBeenCalledWith("exports", {}, { jobId: "startup-exports", removeOnComplete: true });
    const reconcileProjectExports = vi.fn(async () => "export-reconciled");
    const process = await run(`return ${cronWorker.arguments[1].getText(parsed)};`, { reconcileProjectExports });
    await expect(process({ name: "exports" })).resolves.toBe("export-reconciled");
    expect(reconcileProjectExports).toHaveBeenCalledTimes(1);
  });

  it.each(["AUTOPILOT_ONLY", "MEDIA_ONLY", "PUBLICATION_ONLY"])("does not register cron or startup jobs in %s mode", async (mode) => {
    const queue = await registeredJobs({ [mode]: true });
    expect(queue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
