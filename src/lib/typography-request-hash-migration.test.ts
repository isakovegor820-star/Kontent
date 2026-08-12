import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("typography request-hash migration", () => {
  it("is additive, transactional, legacy-safe, and mirrored by bootstrap schema", async () => {
    const sql = await readFile(
      resolve(process.cwd(), "db/migrations/20260825_typography_request_hash.sql"),
      "utf8",
    );
    const bootstrap = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");

    expect(sql).toMatch(/^begin;[\s\S]*commit;\s*$/u);
    expect(sql).not.toMatch(/\bdrop\s+(?:table|column)\b|\btruncate\b|\bdelete\s+from\b/iu);
    expect(sql).toContain("alter table project_typography_runs");
    expect(sql).toContain("add column if not exists request_hash char(64)");
    expect(sql).not.toMatch(/request_hash char\(64\)\s+not null/iu);
    expect(sql).toContain("check (request_hash is null or request_hash ~ '^[0-9a-f]{64}$')");

    const body = sql.replace(/^begin;\s*/u, "").replace(/\s*commit;\s*$/u, "").trim();
    expect(bootstrap).toContain(body);
  });
});
