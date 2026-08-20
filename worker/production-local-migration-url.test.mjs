import { describe, expect, it } from "vitest";
import { productionLocalPeerMigrationUrl } from "../scripts/production-local-migration-url.mjs";

describe("production local migration identity", () => {
  it("derives a credential-free peer URL for the exact local database and port", () => {
    const result = productionLocalPeerMigrationUrl(
      "postgresql://aurora_runtime:secret@127.0.0.1:55432/aurora_prod",
    );

    expect(result).toBe(
      "postgresql:///aurora_prod?host=%2Fvar%2Frun%2Fpostgresql&port=55432",
    );
    expect(result).not.toContain("aurora_runtime");
    expect(result).not.toContain("secret");
  });

  it("accepts an existing local Unix-socket target", () => {
    expect(
      productionLocalPeerMigrationUrl(
        "postgresql:///aurora_prod?host=%2Fvar%2Frun%2Fpostgresql",
      ),
    ).toBe("postgresql:///aurora_prod?host=%2Fvar%2Frun%2Fpostgresql&port=5432");
  });

  it("fails closed for a remote database instead of migrating a same-named local database", () => {
    expect(() =>
      productionLocalPeerMigrationUrl("postgresql://runtime:secret@db.example/aurora_prod"),
    ).toThrow(/loopback or Unix-socket/u);
  });

  it("fails closed for malformed or database-less targets", () => {
    expect(() => productionLocalPeerMigrationUrl("not-a-url")).toThrow(/valid PostgreSQL URL/u);
    expect(() => productionLocalPeerMigrationUrl("postgresql://localhost")).toThrow(/name a database/u);
  });
});
