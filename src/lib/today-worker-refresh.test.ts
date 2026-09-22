import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { CRON_SCHEDULES } from "../../worker/cron-schedules.mjs";

const worker = readFileSync(new URL("../../worker.mjs", import.meta.url), "utf8");
const parsed = ts.createSourceFile("worker.mjs", worker, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function findNode(predicate: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (!found) throw new Error("Actual worker cron boundary missing");
  return found;
}
const registration = findNode((node) => ts.isForOfStatement(node) && node.statement.getText(parsed).includes("cronQueue.upsertJobScheduler"));
const cronWorker = findNode((node) => ts.isNewExpression(node) && node.expression.getText(parsed) === "Worker" && node.arguments?.[0]?.getText(parsed) === '"cron"') as ts.NewExpression;
function run(statement: string, bindings: Record<string, unknown>) {
  return new Function(...Object.keys(bindings), `return (async () => { ${statement} })();`)(...Object.values(bindings));
}
async function registeredJobs() {
  const scheduleImport = findNode((node) => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./worker/cron-schedules.mjs") as ts.ImportDeclaration;
  const names = scheduleImport.importClause?.namedBindings;
  expect(names && ts.isNamedImports(names) && names.elements.some((item) => item.name.text === "CRON_SCHEDULES")).toBe(true);
  const cronQueue = { upsertJobScheduler: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}) };
  await run(registration.getText(parsed), {
    cronQueue, CRON_SCHEDULES, AUTOPILOT_ONLY: false, MEDIA_ONLY: false, PUBLICATION_ONLY: false,
  });
  return cronQueue;
}

describe("Today background refresh worker contract", () => {
  // Ревью P2: cron-задачи получают одну повторную попытку через минуту — транзиентный
  // сбой не откладывает stats на 6 ч, а weekly на неделю.
  const retry = { attempts: 2, backoff: { type: "exponential", delay: 60_000 } };

  it("schedules opportunity materialization through the existing cron worker", async () => {
    expect(worker).toContain('import { materializeAllOpportunitySnapshots }');
    const queue = await registeredJobs();
    expect(queue.upsertJobScheduler.mock.calls.filter(([name]) => name === "today-opportunities")).toEqual([
      ["today-opportunities", { pattern: "20,50 * * * *", tz: "Europe/Moscow" }, { name: "today-opportunities", ...retry }],
    ]);
    const pool = {};
    const materializeAllOpportunitySnapshots = vi.fn(async () => "snapshots-refreshed");
    const process = await run(`return ${cronWorker.arguments![1].getText(parsed)};`, { pool, materializeAllOpportunitySnapshots });
    await expect(process({ name: "today-opportunities" })).resolves.toBe("snapshots-refreshed");
    expect(materializeAllOpportunitySnapshots).toHaveBeenCalledExactlyOnceWith(pool);
  });

  it("refreshes public market signals before opportunity snapshots", async () => {
    const queue = await registeredJobs();
    expect(queue.upsertJobScheduler.mock.calls.filter(([name]) => name === "market-signals")).toEqual([
      ["market-signals", { pattern: "5,35 * * * *", tz: "Europe/Moscow" }, { name: "market-signals", ...retry }],
    ]);
    const pool = {};
    const statsProducerQueue = {};
    const refreshOpportunityMarket = vi.fn(async () => "market-refreshed");
    const process = await run(`return ${cronWorker.arguments![1].getText(parsed)};`, {
      pool,
      statsProducerQueue,
      refreshOpportunityMarket,
    });
    await expect(process({ name: "market-signals" })).resolves.toBe("market-refreshed");
    expect(refreshOpportunityMarket).toHaveBeenCalledExactlyOnceWith(pool, statsProducerQueue);
  });

  it("retries channel statistics during the day instead of waiting until tomorrow", async () => {
    const queue = await registeredJobs();
    expect(queue.upsertJobScheduler.mock.calls.filter(([name]) => name === "stats")).toEqual([
      ["stats", { pattern: "0 */6 * * *", tz: "Europe/Moscow" }, { name: "stats", ...retry }],
    ]);
    const collectAllProjectStats = vi.fn(async () => "stats-refreshed");
    const process = await run(`return ${cronWorker.arguments![1].getText(parsed)};`, { collectAllProjectStats });
    await expect(process({ name: "stats" })).resolves.toBe("stats-refreshed");
    expect(collectAllProjectStats).toHaveBeenCalledTimes(1);
  });

  it("records successful result refreshes only after project-scoped statistics complete", () => {
    const collectBlock = worker.slice(worker.indexOf('if (job.name === "collect")'), worker.indexOf('} else if (job.name === "report")'));
    expect(collectBlock).toContain("await collectStats(scope.projectId)");
    expect(collectBlock).toContain("await collectVkStats(scope.projectId)");
    expect(collectBlock).toContain("await recordTodayResultsRefresh(");
    expect(collectBlock).toContain('"success"');
    expect(worker).toContain("where channel.project_id = $1");
    expect(worker).toContain("else today_source_refreshes.last_success_at end");
    expect(worker).toContain('job?.name !== "collect"');
  });
});
