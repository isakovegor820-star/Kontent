import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = await readFile(resolve("scripts/production-migration-ledger-audit.sql"), "utf8");

describe("production migration ledger audit contract", () => {
  it("runs in a repeatable read-only transaction and emits a single JSON evidence object", () => {
    expect(sql).toContain("begin transaction isolation level repeatable read read only;");
    expect(sql).toContain("current_setting('transaction_read_only')");
    expect(sql).toContain("select jsonb_build_object(");
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("contains no mutating SQL operation", () => {
    expect(sql).not.toMatch(/^\s*(?:insert|update|delete|alter|create|drop|truncate|grant|revoke|copy)\b/gimu);
  });

  it("reports hashes and the historical invalidation boundary without returning token values", () => {
    expect(sql).toContain("non_hash_token_rows");
    expect(sql).toContain("non_hash_token_hash_rows");
    expect(sql).toContain("divergent_dual_rows");
    expect(sql).toContain("non_invalidated_pre_migration_rows");
    expect(sql).toContain("created_at <= (select applied_at from session_boundary)");
    expect(sql).not.toMatch(/select\s+(?:s\.)?(?:token|token_hash)\b/iu);
  });
});
