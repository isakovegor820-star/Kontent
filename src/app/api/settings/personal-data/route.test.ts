import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  session: vi.fn(),
  rateLimit: vi.fn(),
  collect: vi.fn(),
  record: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.poolQuery }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.rateLimit,
  clientIp: () => "203.0.113.7",
  rateLimitResponse: () => Response.json({ ok: false, error: "rate_limited" }, { status: 429 }),
}));
vi.mock("@/lib/personal-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/personal-data")>();
  return { ...actual, collectUserData: mocks.collect, recordDataRequest: mocks.record };
});

import { GET } from "./route";

const user = { id: 7, email: "user@example.test", name: "Иван" };

describe("personal data export route", () => {
  beforeEach(() => {
    mocks.session.mockResolvedValue(user);
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.record.mockResolvedValue(undefined);
    mocks.collect.mockResolvedValue({
      generatedAt: "2026-10-02T19:00:00.000Z",
      account: { id: 7, email: "user@example.test", name: "Иван", createdAt: null, onboardingCompletedAt: null, hasPassword: true },
      consents: [],
      projects: [],
      channels: [],
      posts: [],
      drafts: [],
      sessions: { active: 1 },
    });
  });
  afterEach(() => vi.clearAllMocks());

  it("returns the data as a downloadable file", async () => {
    const response = await GET(new NextRequest("http://localhost/api/settings/personal-data"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.account.email).toBe("user@example.test");
    expect(body.notice).toContain("выгрузка");
    // Факт запроса фиксируется: по нему видно срок исполнения.
    expect(mocks.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 7, kind: "export", state: "completed" }),
    );
  });

  it("requires a session", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/settings/personal-data"));
    expect(response.status).toBe(401);
    expect(mocks.collect).not.toHaveBeenCalled();
  });

  it("does not pretend success when collection fails", async () => {
    mocks.collect.mockRejectedValue(new Error("user_not_found"));
    const response = await GET(new NextRequest("http://localhost/api/settings/personal-data"));
    expect(response.status).toBe(500);
  });
});
