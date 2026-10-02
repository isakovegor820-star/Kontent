import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  find: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.admin }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
// Лимит замокан: иначе тест ходит в живой Redis и падает там, где его нет.
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.rateLimit,
  rateLimitResponse: () => Response.json({ ok: false, error: "rate_limited" }, { status: 429 }),
}));
vi.mock("@/lib/consent-evidence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/consent-evidence")>();
  return { ...actual, findConsentEvidence: mocks.find };
});

import { GET } from "./route";

const evidence = {
  account: { id: 7, email: "user@example.test", name: "Иван", status: "active" as const },
  rows: [
    {
      id: 2,
      userId: 7,
      contact: null,
      kind: "pd_processing",
      granted: false,
      grantedAt: "2026-10-02T19:00:00.000Z",
      source: "cabinet",
      policyVersion: "2026-08-24",
      consentTextVersion: "draft-2026-10",
      hasIp: true,
      hasUserAgent: true,
    },
    {
      id: 1,
      userId: 7,
      contact: null,
      kind: "pd_processing",
      granted: true,
      grantedAt: "2026-10-02T18:00:00.000Z",
      source: "register",
      policyVersion: "2026-08-24",
      consentTextVersion: "draft-2026-10",
      hasIp: true,
      hasUserAgent: true,
    },
  ],
  leadContact: "lead@example.test",
  lead: { id: 5, contact: "lead@example.test", source: "landing", createdAt: "2026-10-01T10:00:00.000Z" },
};

function request(query: string) {
  return new NextRequest(`http://localhost/api/admin/consents${query}`);
}

describe("admin consent evidence route", () => {
  beforeEach(() => {
    mocks.session.mockResolvedValue({ id: 1, email: "admin@example.test", name: "Админ" });
    mocks.admin.mockReturnValue(true);
    mocks.find.mockResolvedValue(evidence);
    mocks.rateLimit.mockResolvedValue({ allowed: true });
  });
  afterEach(() => vi.clearAllMocks());

  it("requires a session and admin access", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await GET(request("?userId=7"))).status).toBe(401);

    mocks.session.mockResolvedValue({ id: 2, email: "user@example.test", name: "Не админ" });
    mocks.admin.mockReturnValue(false);
    expect((await GET(request("?userId=7"))).status).toBe(403);
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it("explains what to pass when there is no query", async () => {
    const response = await GET(request(""));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "query_required" });
  });

  it("returns both the current state and the full history", async () => {
    const response = await GET(request("?userId=7"));
    expect(response.status).toBe(200);
    const body = await response.json();
    // Текущее состояние — свежая запись по виду: согласие отозвано.
    expect(body.current).toEqual([
      expect.objectContaining({ kind: "pd_processing", granted: false, source: "cabinet" }),
    ]);
    // История сохраняется целиком: по ней видно, что согласие было дано.
    expect(body.rows).toHaveLength(2);
    expect(body.account.status).toBe("active");
  });

  it("finds a person from a lead form by contact", async () => {
    const response = await GET(request("?contact=Lead@Example.test"));
    expect(response.status).toBe(200);
    expect(mocks.find).toHaveBeenCalledWith(expect.anything(), { userId: null, contact: "Lead@Example.test" });
    const body = await response.json();
    expect(body.leadContact).toBe("lead@example.test");
  });

  it("downloads the evidence as a CSV file", async () => {
    const response = await GET(request("?userId=7&format=csv"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    // BOM проверяем на байтах: `response.text()` декодирует UTF-8 и убирает
    // метку, поэтому на уровне HTTP-ответа её видно только в buffer.
    const bytes = new Uint8Array(await response.clone().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = await response.text();
    expect(csv).toContain("granted_at");
    expect(csv).toContain("pd_processing");
    // Адрес и клиентский агент в выгрузке не раскрываются — только факт фиксации.
    expect(csv).toContain("ip_recorded");
    expect(csv).not.toContain("203.0.113.7");
  });

  it("stops a mass export with a rate limit", async () => {
    mocks.rateLimit.mockResolvedValue({ allowed: false });
    const response = await GET(request("?userId=7&format=csv"));
    expect(response.status).toBe(429);
    // До выгрузки персональных данных дело не дошло.
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it("does not hide a server failure behind an empty result", async () => {
    mocks.find.mockRejectedValue(new Error("db down"));
    const response = await GET(request("?userId=7"));
    expect(response.status).toBe(500);
  });
});
