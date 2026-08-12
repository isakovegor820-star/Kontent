import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("monthly campaign migration policy", () => {
  it("is additive, transactional and enforces same-project lineage", async () => {
    const sql = await readFile(resolve(process.cwd(), "db/migrations/20260814_monthly_campaigns.sql"), "utf8");
    const bootstrap = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");
    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(sql).not.toMatch(/\bdrop\s+(?:table|column)\b|\btruncate\b|\bdelete\s+from\b/iu);
    expect(sql).toContain("create table if not exists monthly_campaigns");
    expect(sql).toContain("create table if not exists monthly_campaign_plans");
    expect(sql).toContain("create table if not exists monthly_campaign_items");
    expect(sql).toContain("create table if not exists monthly_campaign_regeneration_outbox");
    expect(sql).toContain("foreign key (weekly_autopilot_plan_id, project_id)");
    expect(sql).toContain("foreign key (draft_id, project_id)");
    expect(sql).toContain("foreign key (post_id, project_id)");
    expect(sql).toContain("foreign key (latest_post_stats_id, post_id, project_id)");
    expect(sql).toContain("deferrable initially immediate");
    const body = sql.replace(/^begin;\s*/u, "").replace(/\s*commit;\s*$/u, "").trim();
    expect(bootstrap).toContain(body);
  });
});
