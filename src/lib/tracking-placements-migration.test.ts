import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("tracking placement migration", () => {
  const sql = fs.readFileSync(
    path.join(process.cwd(), "db/migrations/20260820_tracking_placements.sql"),
    "utf8",
  );

  it("adds an opaque post-owned placement and preserves composite project isolation", () => {
    expect(sql).toContain("create table if not exists short_link_placements");
    expect(sql).toContain("foreign key (short_link_id, project_id)");
    expect(sql).toContain("foreign key (publication_operation_id, project_id)");
    expect(sql).toContain("foreign key (post_id, project_id)");
    expect(sql).toContain("unique (post_id)");
    expect(sql).toContain("unique (id, short_link_id, project_id)");
    expect(sql).toContain("on delete set null (publication_operation_id)");
    expect(sql).toContain("on delete set null (post_id)");
    expect(sql).toContain("on delete set null (placement_id)");
    expect(sql).toContain("on delete set null (short_link_placement_id)");
    expect(sql).toContain("add column if not exists placement_id bigint");
    expect(sql).toContain("add column if not exists short_link_placement_id bigint");
    expect(sql).not.toMatch(/drop\s+(?:table|column)/iu);
  });
});
