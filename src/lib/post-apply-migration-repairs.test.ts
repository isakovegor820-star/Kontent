import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("post-apply migration repairs", () => {
  it("preserves the exact bytes of migrations that had already run", async () => {
    const migration15 = await readFile(
      resolve(process.cwd(), "db/migrations/20260815_autopilot_project_scope.sql"),
      "utf8",
    );
    const migration16 = await readFile(
      resolve(process.cwd(), "db/migrations/20260816_publication_extras.sql"),
      "utf8",
    );

    expect(createHash("sha256").update(migration15).digest("hex"))
      .toBe("e12dc8097b7ba93552892525d90df6da3d6b6933709cc26d95c84448a708e659");
    expect(createHash("sha256").update(migration16).digest("hex"))
      .toBe("474ef7aeef447e07ce2a7bc26b3457c07132c0ac98a30632337ef3e82ba4ecff");
  });

  it("moves every later amendment to one additive transaction", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260827_post_apply_migration_repairs.sql"),
      "utf8",
    );

    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(sql).not.toMatch(/\bdrop\s+(?:table|column)\b|\btruncate\b|\bdelete\s+from\b/iu);
    expect(sql).toContain("add column if not exists item_regeneration_version bigint");
    expect(sql).toContain("add column if not exists version bigint");
    expect(sql).toContain("alter column version set default 1");
    expect(sql).toContain("alter column version set not null");
    expect(sql).toContain("autopilot_plan_approval_operation_project_fk");
    expect(sql).toContain("publication_review_tasks_version_check");
    expect(sql).toContain(
      "drop constraint if exists publication_extra_operations_project_id_post_id_sequence_in_key",
    );
  });
});
