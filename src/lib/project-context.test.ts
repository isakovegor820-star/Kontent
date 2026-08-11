import { describe, expect, it, vi } from "vitest";

import {
  changeProjectMemberRole,
  ensureDefaultPersonalProjectInTransaction,
  ProjectMembershipMutationError,
  selectProjectForUser,
} from "./project-context";

function transactionHarness(handler: (sql: string, params?: unknown[]) => unknown) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const result = handler(sql, params);
    return result ?? { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) };
  return { pool, client, query };
}

describe("project context foundation", () => {
  it("creates an idempotent personal owner project without storing a secret", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("insert into projects")) return { rows: [{ id: "41" }] };
      return { rows: [] };
    });

    await expect(ensureDefaultPersonalProjectInTransaction({ query } as never, 9)).resolves.toBe(41);
    const sql = query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).toContain("'owner', 'active'");
    expect(sql).toContain("user_project_preferences");
    expect(sql).toContain("bootstrap:personal-project:");
    expect(sql).not.toContain("token_hash");
  });

  it("treats a client project id only as a selector and rolls back without membership", async () => {
    const h = transactionHarness((sql) => {
      if (sql.includes("from project_members member")) return { rows: [] };
      return { rows: [] };
    });

    await expect(selectProjectForUser(h.pool as never, 7, 88)).rejects.toMatchObject({
      code: "membership_required",
    });
    const statements = h.query.mock.calls.map(([sql]) => String(sql).trim().toLowerCase());
    expect(statements).toContain("rollback");
    expect(statements.some((sql) => sql.startsWith("insert into user_project_preferences"))).toBe(false);
  });

  it("cannot demote the last active owner", async () => {
    const h = transactionHarness((sql) => {
      if (sql.includes("from project_members member")) {
        return { rows: [{ project_id: "5", user_id: "1", role: "owner", version: "2" }] };
      }
      if (sql.includes("select user_id, role, version, status")) {
        return { rows: [{ user_id: "1", role: "owner", version: "4", status: "active" }] };
      }
      return { rows: [] };
    });

    await expect(changeProjectMemberRole({
      pool: h.pool as never,
      actorUserId: 1,
      projectId: 5,
      memberUserId: 1,
      role: "approver",
      expectedVersion: 4,
    })).rejects.toEqual(expect.objectContaining({
      name: ProjectMembershipMutationError.name,
      code: "last_owner",
    }));
    expect(h.query.mock.calls.some(([sql]) => String(sql).trim().startsWith("update project_members"))).toBe(false);
  });

  it("uses optimistic membership versions before mutating", async () => {
    const h = transactionHarness((sql) => {
      if (sql.includes("from project_members member")) {
        return { rows: [{ project_id: "5", user_id: "1", role: "owner", version: "2" }] };
      }
      if (sql.includes("select user_id, role, version, status")) {
        return { rows: [
          { user_id: "1", role: "owner", version: "2", status: "active" },
          { user_id: "2", role: "author", version: "6", status: "active" },
        ] };
      }
      return { rows: [] };
    });

    await expect(changeProjectMemberRole({
      pool: h.pool as never,
      actorUserId: 1,
      projectId: 5,
      memberUserId: 2,
      role: "approver",
      expectedVersion: 5,
    })).rejects.toMatchObject({ code: "version_conflict" });
    expect(h.query.mock.calls.some(([sql]) => String(sql).trim().startsWith("update project_members"))).toBe(false);
  });
});
