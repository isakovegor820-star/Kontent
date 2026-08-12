import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("typographer and brand dictionary migration", () => {
  it("is additive, transactional and project scoped", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260818_typographer_brand_dictionary.sql"),
      "utf8",
    );
    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(sql).not.toMatch(/\bdrop\s+(?:table|column)\b|\btruncate\b|\bdelete\s+from\b/iu);
    expect(sql).toContain("create table if not exists project_brand_dictionaries");
    expect(sql).toContain("create table if not exists project_brand_dictionary_entries");
    expect(sql).toContain("create table if not exists project_typography_runs");
    expect(sql).toContain("foreign key (draft_id, project_id)");
    expect(sql).toContain("unique (project_id, request_key)");
    expect(sql).toContain("where review_complete and undone_at is null");
  });

  it("persists every required dictionary category and immutable rule lineage", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260818_typographer_brand_dictionary.sql"),
      "utf8",
    );
    for (const kind of ["canonical", "allowed", "prohibited", "exception", "abbreviation"]) {
      expect(sql).toContain(`'${kind}'`);
    }
    expect(sql).toContain("rules_version");
    expect(sql).toContain("dictionary_version");
    expect(sql).toContain("source_text_hash");
    expect(sql).toContain("result_text_hash");
    expect(sql).toContain("rejected_suggestion_ids");
  });
});
