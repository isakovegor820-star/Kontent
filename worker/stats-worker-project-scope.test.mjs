import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");

function between(start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`worker block not found: ${start}`);
  return source.slice(startIndex, endIndex);
}

describe("stats worker project isolation contract", () => {
  it("scopes every Telegram stats read/write through projectId", () => {
    const block = between("async function collectStats(projectId)", "const VK_CONCURRENCY");

    expect(block).toContain('requireStatsProjectId(projectId, "collect")');
    expect(block).toContain("where project_id = $1 and network = 'tg'");
    expect(block).toContain("channel.project_id = $3");
    expect(block).toContain("channel.project_id = $5");
    expect(block).toContain("p.project_id = $2");
    expect(block).toContain("project_post.project_id = $2");
    expect(block).toContain("project_post.project_id = $5");
    expect(block).toContain("where id = $1 and project_id = $2");
    expect(block).toContain("where channel_id = $1\n            and project_id = $2");
    expect(block).not.toContain("user_id = $1");
  });

  it("scopes every VK stats read/write through projectId", () => {
    const block = between("async function collectVkStats(projectId)", "async function collectAllProjectStats");

    expect(block).toContain('requireStatsProjectId(projectId, "collect-vk")');
    expect(block).toContain("where project_id = $1 and network = 'vk'");
    expect(block).toContain("channel.project_id = $3");
    expect(block).toContain("channel.project_id = $5");
    expect(block).toContain("where channel_id = $1 and project_id = $2");
    expect(block).toContain("and project_id = $4");
    expect(block).toContain("project_post.project_id = $7");
    expect(block).toContain("where id = $1 and project_id = $2");
    expect(block).not.toContain("and ($1::bigint is null or user_id = $1)");
  });

  it("requires membership for manual jobs and keeps cron runs project-by-project", () => {
    const queueBlock = between("const statsWorker =", "statsWorker?.on(\"error\"");
    const cronBlock = between("const cronWorker =", "cronWorker?.on(\"failed\"");

    expect(queueBlock).toContain('requireStatsJobProjectScope(pool, job.data, "collect")');
    expect(queueBlock).toContain('requireStatsJobProjectScope(pool, job.data, "report")');
    expect(queueBlock).toContain("collectStats(scope.projectId)");
    expect(queueBlock).toContain("collectVkStats(scope.projectId)");
    expect(queueBlock).toContain("buildWeeklyReport(pool, scope)");
    expect(queueBlock).toContain("new UnrecoverableError(error.message)");
    expect(cronBlock).toContain('case "stats":    return collectAllProjectStats();');
    expect(source).not.toContain("collectStats()");
    expect(source).not.toContain("collectVkStats()");
  });
});
