import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  acceptProjectInvitation,
  createProject,
  createProjectInvitation,
  hashInvitationToken,
  listProjectMembers,
  parseInvitationTtlDays,
} from "./project-team";

function transactionHarness(handler: (sql: string, params?: unknown[]) => unknown) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    const result = handler(sql, params);
    return result ?? { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), query };
  return { pool, client, query };
}

function ownerMembership(sql: string) {
  if (sql.includes("from project_members member") && sql.includes("join projects project")) {
    return { rows: [{ project_id: "7", user_id: "1", role: "owner", version: "1" }], rowCount: 1 };
  }
  return null;
}

describe("project and team services", () => {
  it("creates a team project, its owner, current selection and audit atomically", async () => {
    const h = transactionHarness((sql) => {
      if (sql.includes("select id from users where id")) return { rows: [{ id: "4" }], rowCount: 1 };
      if (sql.includes("insert into projects")) {
        return {
          rows: [{ id: "17", name: "Судебная практика", timezone: "Europe/Moscow", version: "1", created_at: "2026-08-11T10:00:00Z" }],
          rowCount: 1,
        };
      }
      return null;
    });

    const project = await createProject({
      pool: h.pool as never,
      actorUserId: 4,
      name: "  Судебная   практика ",
      timezone: "Europe/Moscow",
      requestId: "request-1",
    });

    expect(project).toMatchObject({ id: 17, name: "Судебная практика", role: "owner", selected: true });
    const sql = h.query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).toContain("insert into project_members");
    expect(sql).toContain("user_project_preferences");
    expect(sql).toContain("'project.created'");
    expect(h.query.mock.calls.at(-2)?.[0]).toContain("audit_events");
    expect(h.query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("replays project creation under the same idempotency key without a second insert", async () => {
    const h = transactionHarness((sql) => {
      if (sql.includes("select id from users where id")) return { rows: [{ id: "4" }], rowCount: 1 };
      if (sql.includes("from audit_events event")) {
        return {
          rows: [{
            id: "17",
            name: "Команда",
            timezone: "UTC",
            project_version: "1",
            member_version: "2",
            role: "owner",
            selected: false,
            fingerprint: createHash("sha256").update(JSON.stringify(["Команда", "UTC"])).digest("hex"),
            created_at: "2026-08-11T10:00:00Z",
          }],
          rowCount: 1,
        };
      }
      return null;
    });

    await expect(createProject({
      pool: h.pool as never,
      actorUserId: 4,
      name: "Команда",
      idempotencyKey: "create-project-0001",
    })).resolves.toMatchObject({ id: 17, role: "owner", selected: false, version: 2 });
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes("insert into projects"))).toBe(false);
    expect(h.query.mock.calls.at(-1)?.[0]).toBe("commit");
  });

  it("denies a cross-project member list before reading that project's people", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from project_members member") && sql.includes("join projects project")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(listProjectMembers({
      pool: { query } as never,
      actorUserId: 8,
      projectId: 999,
    })).rejects.toEqual(expect.objectContaining({ code: "membership_required" }));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("select member.user_id"))).toBe(false);
  });

  it("stores only a SHA-256 invitation hash and keeps audit data free of email and token", async () => {
    let storedParams: unknown[] = [];
    let auditParams: unknown[] = [];
    const h = transactionHarness((sql, params) => {
      const access = ownerMembership(sql);
      if (access) return access;
      if (sql.includes("insert into project_invitations")) {
        storedParams = params ?? [];
        return { rows: [{ id: "81", expires_at: "2026-08-18T10:00:00Z", created_at: "2026-08-11T10:00:00Z" }], rowCount: 1 };
      }
      if (sql.includes("insert into audit_events")) auditParams = params ?? [];
      return null;
    });

    const result = await createProjectInvitation({
      pool: h.pool as never,
      actorUserId: 1,
      projectId: 7,
      email: "  Lawyer@Example.COM ",
      role: "approver",
      ttlDays: 7,
      requestId: "request-2",
    });

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(storedParams[1]).toBe("lawyer@example.com");
    expect(storedParams[3]).toBe(hashInvitationToken(result.token));
    expect(storedParams[3]).not.toBe(result.token);
    expect(String(storedParams[3])).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(auditParams)).not.toContain("lawyer@example.com");
    expect(JSON.stringify(auditParams)).not.toContain(result.token);
  });

  it("bounds invitation lifetime to 1–30 whole days", () => {
    expect(parseInvitationTtlDays(undefined)).toBe(7);
    expect(parseInvitationTtlDays(1)).toBe(1);
    expect(parseInvitationTtlDays(30)).toBe(30);
    expect(() => parseInvitationTtlDays(31)).toThrowError(expect.objectContaining({ code: "invalid_ttl" }));
    expect(() => parseInvitationTtlDays(0.5)).toThrowError(expect.objectContaining({ code: "invalid_ttl" }));
  });

  it.each([
    ["already accepted", { accepted_at: "2026-08-11T09:00:00Z", revoked_at: null, expires_at: "2026-08-18T10:00:00Z" }, "invitation_used"],
    ["revoked", { accepted_at: null, revoked_at: "2026-08-11T09:00:00Z", expires_at: "2026-08-18T10:00:00Z" }, "invitation_revoked"],
    ["expired", { accepted_at: null, revoked_at: null, expires_at: "2020-01-01T00:00:00Z" }, "invitation_expired"],
  ])("rejects an %s invitation atomically", async (_label, state, code) => {
    const token = "a".repeat(43);
    const h = transactionHarness((sql) => {
      if (sql.includes("from project_invitations")) {
        return {
          rows: [{ id: "3", project_id: "7", email: "member@example.com", role: "author", ...state }],
          rowCount: 1,
        };
      }
      return null;
    });

    await expect(acceptProjectInvitation({
      pool: h.pool as never, actorUserId: 5, token,
    })).rejects.toMatchObject({ code });
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes("insert into project_members"))).toBe(false);
    expect(h.query.mock.calls.at(-1)?.[0]).toBe("rollback");
  });

  it("requires the authenticated account email and rejects invite reuse", async () => {
    const token = "b".repeat(43);
    const h = transactionHarness((sql) => {
      if (sql.includes("from project_invitations")) {
        return {
          rows: [{
            id: "9",
            project_id: "7",
            email: "right@example.com",
            role: "publisher",
            expires_at: "2099-01-01T00:00:00Z",
            accepted_at: null,
            revoked_at: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("from users where id")) {
        return { rows: [{ email: "wrong@example.com" }], rowCount: 1 };
      }
      return null;
    });

    await expect(acceptProjectInvitation({
      pool: h.pool as never, actorUserId: 5, token,
    })).rejects.toMatchObject({ code: "email_mismatch" });
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes("update project_invitations"))).toBe(false);
  });

  it("accepts once, restores membership if needed and selects the joined project", async () => {
    const token = "c".repeat(43);
    const h = transactionHarness((sql) => {
      if (sql.includes("from project_invitations")) {
        return {
          rows: [{
            id: "9", project_id: "7", email: "member@example.com", role: "publisher",
            expires_at: "2099-01-01T00:00:00Z", accepted_at: null, revoked_at: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("from users where id")) return { rows: [{ email: "member@example.com" }], rowCount: 1 };
      if (sql.includes("select status, version")) return { rows: [], rowCount: 0 };
      if (sql.includes("update project_invitations")) return { rows: [], rowCount: 1 };
      return null;
    });

    await expect(acceptProjectInvitation({
      pool: h.pool as never, actorUserId: 5, token,
    })).resolves.toEqual({ projectId: 7, role: "publisher" });
    const sql = h.query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).toContain("insert into project_members");
    expect(sql).toContain("user_project_preferences");
    expect(sql).toContain("'project.invitation.accepted'");
    expect(h.query.mock.calls.at(-1)?.[0]).toBe("commit");
  });
});
