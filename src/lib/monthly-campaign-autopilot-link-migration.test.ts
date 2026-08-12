import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("monthly campaign Autopilot lineage migration", () => {
  it("is additive, transactional and mirrors the bootstrap schema", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260819_monthly_campaign_autopilot_link.sql"),
      "utf8",
    );
    const bootstrap = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");

    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(sql).not.toMatch(/\bdrop\s+(?:table|column)\b|\btruncate\b|\bdelete\s+from\b/iu);
    expect(sql).toContain("add column if not exists monthly_campaign_plan_id bigint");
    expect(sql).toContain("foreign key (monthly_campaign_plan_id, project_id)");
    expect(sql).toContain("references monthly_campaign_plans (id, project_id)");
    expect(sql).toContain("where monthly_campaign_plan_id is not null");

    const body = sql.replace(/^begin;\s*/u, "").replace(/\s*commit;\s*$/u, "").trim();
    expect(bootstrap).toContain(body);
  });
});
