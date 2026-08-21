import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = await readFile(
  new URL("../../db/migrations/20260926_autopilot_candidate_pool.sql", import.meta.url),
  "utf8",
);
const schema = await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8");

describe("Autopilot candidate pool migration", () => {
  it("adds a build-only candidate pool without rewriting plans or channel settings", () => {
    expect(migration).toContain("add column if not exists publication_target_count smallint");
    expect(migration).toContain("add column if not exists candidate_count smallint");
    expect(migration).toContain("add column if not exists candidate_items jsonb");
    expect(migration).toContain("candidate_count >= publication_target_count");
    expect(migration).toContain("candidate_items is null or jsonb_typeof(candidate_items) = 'array'");
    expect(migration).not.toMatch(/update\s+autopilot_(?:plan|settings)/iu);
    expect(migration).not.toMatch(/delete\s+from/iu);
  });

  it("keeps the bootstrap schema in sync with the additive migration", () => {
    for (const fragment of [
      "publication_target_count smallint",
      "candidate_count smallint",
      "candidate_items jsonb",
      "autopilot_plan_candidate_target_check",
    ]) expect(schema).toContain(fragment);
  });
});
