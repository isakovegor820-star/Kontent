import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { registerPasswordUser } from "./password-registration";

function harness(rows: Array<{ id: number }> = [{ id: 9 }]) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql.trim().toLowerCase());
      return sql.includes("returning id") ? { rows } : { rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) }, client, queries };
}

describe("atomic password registration", () => {
  it("inserts email and password hash in one transaction", async () => {
    const h = harness();
    await expect(registerPasswordUser({
      pool: h.pool as unknown as Pick<Pool, "connect">,
      email: "new@example.test",
      name: "New",
      passwordHash: "salt:hash",
    })).resolves.toEqual({ ok: true, userId: 9 });
    expect(h.client.query).toHaveBeenCalledWith(expect.stringContaining("password_hash"), [
      "new@example.test", "New", "salt:hash",
    ]);
    expect(h.queries).toEqual(expect.arrayContaining(["begin", "commit"]));
    expect(h.client.release).toHaveBeenCalledOnce();
  });

  it("rolls back a fault after INSERT", async () => {
    const h = harness();
    await expect(registerPasswordUser({
      pool: h.pool as unknown as Pick<Pool, "connect">,
      email: "fault@example.test",
      name: "Fault",
      passwordHash: "salt:hash",
      afterInsert: () => { throw new Error("fault_after_insert"); },
    })).rejects.toThrow("fault_after_insert");
    expect(h.queries).toContain("rollback");
    expect(h.queries).not.toContain("commit");
  });

  it("maps a conflicting existing identity to stable email_taken", async () => {
    const h = harness([]);
    await expect(registerPasswordUser({
      pool: h.pool as unknown as Pick<Pool, "connect">,
      email: "social@example.test",
      name: "Social",
      passwordHash: "salt:hash",
    })).resolves.toEqual({ ok: false, error: "email_taken" });
    expect(h.queries).toContain("rollback");
  });
});
