import { describe, expect, it, vi } from "vitest";

import { assertKnownSessionMigrationState } from "../../scripts/migrate.mjs";

const original = "30c7987f372e4259b23fdc2d8bbee7257009b92e85385828741807c3c6f814ec";
const appliedAt = "2026-08-20T10:00:00.000Z";

describe("historical session migration reconciliation", () => {
  it("accepts the original checksum only with hashed, expired token rows and its constraint", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ column_name: "token" }] })
      .mockResolvedValueOnce({ rows: [{ invalid_hashes: 0, non_invalidated_legacy: 0 }] })
      .mockResolvedValueOnce({ rows: [{ present: true }] });
    await expect(assertKnownSessionMigrationState({ query }, original, appliedAt)).resolves.toBeUndefined();
    expect(query.mock.calls[1][0]).toContain("created_at <= $1");
    expect(query.mock.calls[1][1]).toEqual([appliedAt]);
  });

  it("rejects the original checksum when its actual schema or rows do not match", async () => {
    const wrongSchema = { query: vi.fn().mockResolvedValueOnce({ rows: [{ column_name: "token_hash" }] }) };
    await expect(assertKnownSessionMigrationState(wrongSchema, original, appliedAt)).rejects.toThrow(
      "historical checksum does not match sessions schema",
    );

    const activePlaintext = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ column_name: "token" }] })
      .mockResolvedValueOnce({ rows: [{ invalid_hashes: 1, non_invalidated_legacy: 0 }] }) };
    await expect(assertKnownSessionMigrationState(activePlaintext, original, appliedAt)).rejects.toThrow(
      "historical token rows are not hashed",
    );
  });

  it("allows active hashed sessions created after the historical ledger entry", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ column_name: "token" }] })
      .mockResolvedValueOnce({ rows: [{ invalid_hashes: 0, non_invalidated_legacy: 0 }] })
      .mockResolvedValueOnce({ rows: [{ present: true }] });
    await expect(assertKnownSessionMigrationState({ query }, original, appliedAt)).resolves.toBeUndefined();
  });

  it("rejects a pre-existing session that was not invalidated at the ledger boundary", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ column_name: "token" }] })
      .mockResolvedValueOnce({ rows: [{ invalid_hashes: 0, non_invalidated_legacy: 1 }] });
    await expect(assertKnownSessionMigrationState({ query }, original, appliedAt)).rejects.toThrow(
      "historical session rows were not invalidated",
    );
  });

  it("rejects every unknown checksum without querying or mutating the database", async () => {
    const query = vi.fn();
    await expect(assertKnownSessionMigrationState({ query }, "f".repeat(64), appliedAt)).rejects.toThrow(
      "unknown historical checksum",
    );
    expect(query).not.toHaveBeenCalled();
  });
});
