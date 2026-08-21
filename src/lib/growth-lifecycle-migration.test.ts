import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(new URL("../../db/migrations/20260924_growth_weekly_loop.sql", import.meta.url), "utf8");

describe("Growth weekly loop migration", () => {
  it("keeps project-scoped referential integrity without a text-polymorphic artifact", () => {
    expect(sql).toContain("foreign key (artifact_draft_id, project_id)");
    expect(sql).toContain("references drafts (id, project_id)");
    expect(sql).toContain("foreign key (artifact_autopilot_plan_id, project_id)");
    expect(sql).toContain("references autopilot_plan (id, project_id)");
    expect(sql).toContain("num_nonnulls(artifact_draft_id, artifact_autopilot_plan_id) <= 1");
    expect(sql).not.toContain("artifact_type");
  });
});
