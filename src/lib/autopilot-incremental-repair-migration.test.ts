import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = await readFile(
  new URL("../../db/migrations/20260923_autopilot_incremental_repair.sql", import.meta.url),
  "utf8",
);

describe("incremental Autopilot repair migration", () => {
  it("adds a separate partial build lifecycle without rewriting existing settings", () => {
    expect(migration).toContain("'building', 'partial', 'pending', 'approving', 'approved'");
    expect(migration).toContain("add column if not exists build_report jsonb");
    expect(migration).toContain("alter column post_frequency set default 5");
    expect(migration).not.toMatch(/update\s+autopilot_settings\s+set\s+post_frequency/iu);
  });

  it("keeps a durable idempotency identity after the source plan is atomically replaced", () => {
    expect(migration).toContain("source_plan_id     bigint not null");
    expect(migration).toContain("constraint autopilot_repair_operations_job_uniq unique (project_id, job_id)");
    expect(migration).toContain("autopilot_repair_operations_active_plan_uniq");
    expect(migration).toContain("on delete set null");
  });
});
