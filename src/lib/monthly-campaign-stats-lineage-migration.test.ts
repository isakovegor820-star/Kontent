import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("monthly campaign stats lineage migration", () => {
  it("is transactional, project-scoped, newest-only, and mirrored by bootstrap", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260826_monthly_campaign_stats_lineage.sql"),
      "utf8",
    );
    const bootstrap = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");
    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(sql).not.toMatch(/\btruncate\b|\bdelete\s+from\b|\bdrop\s+(?:table|column)\b/iu);
    expect(sql).toContain("item.project_id = new.project_id");
    expect(sql).toContain("item.post_id = new.post_id");
    expect(sql).toContain("(previous.snapshot_date, previous.id) < (new.snapshot_date, new.id)");
    expect(sql).toContain("after insert or update of views, reactions, reposts, comments, collected_at");
    const body = sql.replace(/^begin;\s*/u, "").replace(/\s*commit;\s*$/u, "").trim();
    expect(bootstrap).toContain(body);
  });
});
