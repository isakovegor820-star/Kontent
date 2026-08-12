import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("legal visual migration policy", () => {
  it("is transactional and mirrors the bootstrap schema", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260817_legal_visuals.sql"),
      "utf8",
    );
    const bootstrap = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");

    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(sql).not.toMatch(/\bdrop\s+(?:table|column)\b|\btruncate\b|\bdelete\s+from\b/iu);
    expect(sql).toContain("create table if not exists project_brand_kits");
    expect(sql).toContain("create table if not exists legal_visual_designs");
    expect(sql).toContain("create table if not exists legal_visual_render_outbox");
    expect(sql).toContain("create table if not exists legal_video_scripts");
    expect(sql).toContain("foreign key (operation_id, project_id, design_id)");
    expect(sql).toContain("foreign key (source_draft_revision_id, project_id, source_draft_id, source_draft_version)");

    for (const invariant of [
      "project_brand_kits",
      "legal_visual_render_outbox",
      "legal_video_script_revisions",
    ]) {
      expect(bootstrap).toContain(invariant);
    }
  });
});
