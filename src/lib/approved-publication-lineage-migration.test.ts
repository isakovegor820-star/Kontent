import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("approved publication lineage migration", () => {
  it("is additive, transactional, and mirrored by the bootstrap schema", async () => {
    const sql = await readFile(
      resolve(
        process.cwd(),
        "db/migrations/20260821_approved_publication_lineage.sql",
      ),
      "utf8",
    );
    const bootstrap = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");

    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(sql).not.toMatch(/\bdrop\s+(?:table|column)\b|\btruncate\b|\bdelete\s+from\b/iu);
    expect(sql).toContain("add column if not exists approved_revision_id bigint");
    expect(sql).toContain("add column if not exists approved_draft_version bigint");
    expect(sql).toContain("add column if not exists approved_content_hash char(64)");
    expect(sql).not.toMatch(
      /add column if not exists approved_revision_id bigint\s+not null/iu,
    );
    expect(sql).not.toMatch(
      /add column if not exists approved_draft_version bigint\s+not null/iu,
    );
    expect(sql).not.toMatch(
      /add column if not exists approved_content_hash char\(64\)\s+not null/iu,
    );

    const body = sql.replace(/^begin;\s*/u, "").replace(/\s*commit;\s*$/u, "").trim();
    expect(bootstrap).toContain(body);
  });

  it("requires one immutable, project-scoped approval lineage for managed rows", async () => {
    const sql = await readFile(
      resolve(
        process.cwd(),
        "db/migrations/20260821_approved_publication_lineage.sql",
      ),
      "utf8",
    );

    expect(sql).toContain("constraint publication_operations_approved_lineage_check");
    expect(sql).toContain("approved_draft_version = draft_version");
    expect(sql).toContain("constraint publication_operations_approved_content_hash_check");
    expect(sql).toContain("constraint draft_revisions_approval_lineage_uniq");
    expect(sql).toContain("unique (id, project_id, draft_id, draft_version, content_hash)");
    expect(sql).toMatch(
      /foreign key \(\s*approved_revision_id,\s*project_id,\s*draft_id,\s*approved_draft_version,\s*approved_content_hash\s*\)\s*references draft_revisions \(\s*id,\s*project_id,\s*draft_id,\s*draft_version,\s*content_hash\s*\)/u,
    );
    expect(sql).toContain("on delete restrict");
  });

  it("fails closed on duplicate approved revisions without rewriting history", async () => {
    const sql = await readFile(
      resolve(
        process.cwd(),
        "db/migrations/20260821_approved_publication_lineage.sql",
      ),
      "utf8",
    );

    expect(sql).toContain("group by project_id, draft_id, approved_revision_id");
    expect(sql).toContain("having count(*) > 1");
    expect(sql).toContain("publication_approved_revision_duplicate");
    expect(sql).toContain("using errcode = '23505'");
    expect(sql).toMatch(
      /create unique index if not exists publication_operations_approved_revision_uniq\s+on publication_operations \(project_id, draft_id, approved_revision_id\)\s+where approved_revision_id is not null;/u,
    );
  });
});
