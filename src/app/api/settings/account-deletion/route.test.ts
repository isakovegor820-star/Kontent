import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  poolQuery: vi.fn(),
  session: vi.fn(),
  rateLimit: vi.fn(),
  purge: vi.fn(),
  blockers: vi.fn(),
  candidates: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.poolQuery, connect: mocks.connect }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.rateLimit,
  clientIp: () => "203.0.113.7",
  rateLimitResponse: () => Response.json({ ok: false, error: "rate_limited" }, { status: 429 }),
}));
vi.mock("@/lib/personal-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/personal-data")>();
  return {
    ...actual,
    purgeAccount: mocks.purge,
    findPurgeBlockers: mocks.blockers,
    findTransferCandidates: mocks.candidates,
    recordDataRequest: mocks.record,
  };
});

import { GET, POST } from "./route";

const user = { id: 7, email: "user@example.test", name: "Иван" };

function request(origin = "http://localhost", body: unknown = { confirm: true }) {
  return new NextRequest("http://localhost/api/settings/account-deletion", {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: "localhost", "sec-fetch-site": "same-origin" },
    body: JSON.stringify(body),
  });
}

describe("account deletion route", () => {
  const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })), release: vi.fn() };

  beforeEach(() => {
    mocks.session.mockResolvedValue(user);
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.poolQuery.mockResolvedValue({ rows: [{ count: 1 }] });
    mocks.blockers.mockResolvedValue([]);
    mocks.candidates.mockResolvedValue([]);
    mocks.record.mockResolvedValue(undefined);
    mocks.purge.mockResolvedValue({
      ok: true,
      deletedPersonalProjects: 1,
      deletedSharedProjects: [],
      transferredSharedProjects: [],
      anonymizedEmail: "deleted-user-7@deleted.invalid",
    });
    mocks.connect.mockResolvedValue(client);
  });
  afterEach(() => {
    vi.clearAllMocks();
    client.query.mockClear();
  });

  it("shows the consequences before anything irreversible", async () => {
    const response = await GET(new NextRequest("http://localhost/api/settings/account-deletion"));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, personalProjects: 1, blockers: [] });
  });

  it("rejects a foreign origin before any work", async () => {
    const response = await POST(request("https://evil.example"));
    expect(response.status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("requires an explicit confirmation flag", async () => {
    const response = await POST(request("http://localhost", {}));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "confirm_required" });
    expect(mocks.purge).not.toHaveBeenCalled();
  });

  it("purges inside a transaction with an advisory lock and records the request", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, deleted: true });

    const statements = (client.query.mock.calls as unknown as Array<[string]>).map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(statements).toContain("commit");
    expect(mocks.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 7, kind: "deletion", state: "completed" }),
    );
  });

  it("explains why deletion is blocked instead of deleting", async () => {
    mocks.purge.mockResolvedValue({
      ok: false,
      error: "shared_project_owner",
      projects: [{ id: 5, name: "Командный" }],
    });
    const response = await POST(request());
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("shared_project_owner");
    expect(body.projects).toEqual([{ id: 5, name: "Командный" }]);
    const statements = (client.query.mock.calls as unknown as Array<[string]>).map(([sql]) => String(sql));
    expect(statements).toContain("rollback");
  });

  it("passes the chosen successor to the purge", async () => {
    await POST(request("http://localhost", { confirm: true, transferSharedTo: 9 }));
    expect(mocks.purge).toHaveBeenCalledWith(expect.anything(), 7, { transferSharedTo: 9 });
  });

  it("offers transfer candidates from the server, not from the client", async () => {
    mocks.blockers.mockResolvedValue([{ id: 5, name: "Командный", hasOtherMembers: true }]);
    mocks.candidates.mockResolvedValue([{ userId: 9, name: "Коллега", role: "author" }]);

    const response = await GET(new NextRequest("http://localhost/api/settings/account-deletion"));
    const body = await response.json();
    expect(body.transferCandidates).toEqual([{ userId: 9, name: "Коллега", role: "author" }]);
    // Кандидатов считает сервер: клиент не решает, кому можно отдать проект.
    expect(mocks.candidates).toHaveBeenCalledWith(expect.anything(), 5, 7);
    expect(body.blockers).toHaveLength(1);
    expect(body.orphanedProjects).toEqual([]);
  });

  it("separates projects that need a successor from those that will be deleted", async () => {
    mocks.blockers.mockResolvedValue([
      { id: 5, name: "С коллегой", hasOtherMembers: true },
      { id: 6, name: "Одинокий", hasOtherMembers: false },
    ]);
    mocks.candidates.mockResolvedValue([{ userId: 9, name: "Коллега", role: "author" }]);

    const body = await (await GET(new NextRequest("http://localhost/api/settings/account-deletion"))).json();
    // Требуют выбора преемника — только те, где есть кому передать.
    expect(body.blockers.map((item: { id: number }) => item.id)).toEqual([5]);
    // Осиротевшие уйдут вместе с аккаунтом: иначе владелец заперт.
    expect(body.orphanedProjects.map((item: { id: number }) => item.id)).toEqual([6]);
    // Кандидатов считаем только для проектов, требующих передачи.
    expect(mocks.candidates).toHaveBeenCalledTimes(1);
  });

  it("offers only candidates who fit every project needing a successor", async () => {
    mocks.blockers.mockResolvedValue([
      { id: 5, name: "Первый", hasOtherMembers: true },
      { id: 6, name: "Второй", hasOtherMembers: true },
    ]);
    mocks.candidates.mockImplementation(async (_db: unknown, projectId: number) =>
      projectId === 5
        ? [{ userId: 9, name: "Общий", role: "author" }, { userId: 10, name: "Только первый", role: "author" }]
        : [{ userId: 9, name: "Общий", role: "author" }, { userId: 11, name: "Только второй", role: "author" }],
    );

    const body = await (await GET(new NextRequest("http://localhost/api/settings/account-deletion"))).json();
    // Один преемник должен подойти каждому проекту, иначе выбор неоднозначен.
    expect(body.transferCandidates.map((item: { userId: number }) => item.userId)).toEqual([9]);
  });

  it("answers 422 when the chosen successor is not a member", async () => {
    mocks.purge.mockResolvedValue({
      ok: false,
      error: "invalid_transfer_target",
      projects: [{ id: 5, name: "Командный" }],
    });
    const response = await POST(request("http://localhost", { confirm: true, transferSharedTo: 99 }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_transfer_target" });
    const statements = (client.query.mock.calls as unknown as Array<[string]>).map(([sql]) => String(sql));
    expect(statements).toContain("rollback");
  });
});
