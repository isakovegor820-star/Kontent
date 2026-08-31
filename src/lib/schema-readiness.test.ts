import { describe, expect, it } from "vitest";
import { SCHEMA_MANIFEST } from "./schema-manifest.mjs";
import { evaluateSchemaSnapshot } from "./schema-readiness.mjs";

function completeSnapshot() {
  return {
    schemaMigrationsTable: true,
    migrations: SCHEMA_MANIFEST.migrations.map((migration) => ({ ...migration })),
    tables: [...SCHEMA_MANIFEST.capabilities.tables],
    columns: [...SCHEMA_MANIFEST.capabilities.columns],
    constraints: [...SCHEMA_MANIFEST.capabilities.constraints],
    indexes: [...SCHEMA_MANIFEST.capabilities.indexes],
  };
}

describe("runtime schema manifest", () => {
  it("accepts only the exact migration checksums and required capabilities", () => {
    expect(evaluateSchemaSnapshot(completeSnapshot())).toEqual({
      ready: true,
      expectedVersion: SCHEMA_MANIFEST.schemaVersion,
      actualVersion: SCHEMA_MANIFEST.schemaVersion,
      appliedMigrations: SCHEMA_MANIFEST.migrations.length,
      expectedMigrations: SCHEMA_MANIFEST.migrations.length,
      forwardMigrations: [],
      reasons: [],
    });
  });

  it("stays ready on the newer additive schema a rollback always lands on", () => {
    const snapshot = completeSnapshot();
    snapshot.migrations.push({ name: "29991231_future_release.sql", checksum: "a".repeat(64) });

    const result = evaluateSchemaSnapshot(snapshot);
    expect(result.ready).toBe(true);
    expect(result.forwardMigrations).toEqual(["29991231_future_release.sql"]);
    expect(result.reasons).toEqual(["schema_forward:29991231_future_release.sql"]);
  });

  it("fails closed on an unknown migration that is not a newer release", () => {
    const snapshot = completeSnapshot();
    snapshot.migrations.push({ name: "20000101_foreign_writer.sql", checksum: "b".repeat(64) });

    const result = evaluateSchemaSnapshot(snapshot);
    expect(result.ready).toBe(false);
    expect(result.forwardMigrations).toEqual([]);
    expect(result.reasons).toEqual(["migration_unexpected:20000101_foreign_writer.sql"]);
  });

  it("keeps required capabilities authoritative even on a newer schema", () => {
    const snapshot = completeSnapshot();
    snapshot.migrations.push({ name: "29991231_future_release.sql", checksum: "a".repeat(64) });
    snapshot.columns = snapshot.columns.filter((name) => name !== "drafts.ai_validation");

    const result = evaluateSchemaSnapshot(snapshot);
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("capability_missing:column:drafts.ai_validation");
  });

  it("reports an exact missing capability on a partial schema", () => {
    const snapshot = completeSnapshot();
    snapshot.columns = snapshot.columns.filter((name) => name !== "drafts.ai_validation");
    expect(evaluateSchemaSnapshot(snapshot)).toMatchObject({
      ready: false,
      reasons: ["capability_missing:column:drafts.ai_validation"],
    });
  });

  it("fails closed for a wrong applied checksum", () => {
    const snapshot = completeSnapshot();
    snapshot.migrations[0] = { ...snapshot.migrations[0], checksum: "0".repeat(64) };
    expect(evaluateSchemaSnapshot(snapshot).reasons).toEqual([
      `migration_checksum_mismatch:${SCHEMA_MANIFEST.migrations[0].name}`,
    ]);
  });

  it("accepts only the documented historical session checksum after full capability reconciliation", () => {
    const snapshot = completeSnapshot();
    const sessionIndex = snapshot.migrations.findIndex(
      (migration) => migration.name === "20260916_session_token_hashes.sql",
    );
    snapshot.migrations[sessionIndex] = {
      ...snapshot.migrations[sessionIndex],
      checksum: "30c7987f372e4259b23fdc2d8bbee7257009b92e85385828741807c3c6f814ec",
    };
    expect(evaluateSchemaSnapshot(snapshot).ready).toBe(true);

    snapshot.migrations[sessionIndex] = {
      ...snapshot.migrations[sessionIndex], checksum: "f".repeat(64),
    };
    expect(evaluateSchemaSnapshot(snapshot).reasons).toEqual([
      "migration_checksum_mismatch:20260916_session_token_hashes.sql",
    ]);
  });

  it("fails closed when schema_migrations is absent even if tables were manually created", () => {
    const snapshot = completeSnapshot();
    snapshot.schemaMigrationsTable = false;
    snapshot.migrations = [];
    const result = evaluateSchemaSnapshot(snapshot);
    expect(result.ready).toBe(false);
    expect(result.reasons).toContain("schema_migrations_table_missing");
    expect(result.reasons.filter((reason) => reason.startsWith("migration_missing:"))).toHaveLength(
      SCHEMA_MANIFEST.migrations.length,
    );
  });
});
