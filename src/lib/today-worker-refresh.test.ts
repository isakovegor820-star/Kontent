import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(new URL("../../worker.mjs", import.meta.url), "utf8");

describe("Today background refresh worker contract", () => {
  it("schedules opportunity materialization through the existing cron worker", () => {
    expect(worker).toContain('import { materializeAllOpportunitySnapshots }');
    expect(worker).toContain('{ name: "today-opportunities", pattern: "30 */2 * * *" }');
    expect(worker).toContain('case "today-opportunities": return materializeAllOpportunitySnapshots(pool)');
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
