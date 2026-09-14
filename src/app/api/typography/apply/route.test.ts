import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  apply: vi.fn(),
  getPool: vi.fn(),
  session: vi.fn(),
  origin: vi.fn(),
  rate: vi.fn(),
}));

vi.mock("@/lib/typography-service", () => ({ applyProjectTypography: mocks.apply }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.origin }));
vi.mock("@/lib/rate-limit", async (original) => ({
  ...await original<typeof import("@/lib/rate-limit")>(),
  checkRateLimit: mocks.rate,
}));

import { POST } from "./route";

function request(origin = "http://localhost") {
  return new NextRequest("http://localhost/api/typography/apply", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      requestKey: "typography:api-test-0001",
      draftId: 41,
      text: "Срок 3-5 дней",
      expectedDictionaryVersion: 3,
      acceptedSuggestionIds: "safe",
      rejectedSuggestionIds: [],
      formatQuotes: false,
    }),
  });
}

describe("POST /api/typography/apply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.origin.mockReturnValue(true);
    mocks.session.mockResolvedValue({ id: 5 });
    mocks.rate.mockResolvedValue({ allowed: true, limit: 240, remaining: 239, retryAfter: 0 });
    mocks.getPool.mockReturnValue({ connect: vi.fn() });
    mocks.apply.mockResolvedValue({ id: 71, duplicate: false, resultText: "Срок 3–5 дней" });
  });

  it("rejects an untrusted origin before session, limiter or database work", async () => {
    mocks.origin.mockReturnValue(false);
    const response = await POST(request("https://attacker.example"));
    expect(response.status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it("rate-limits an authenticated project mutation before service work", async () => {
    mocks.rate.mockResolvedValue({ allowed: false, limit: 240, remaining: 0, retryAfter: 12 });
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("forwards only the bounded contract to the RBAC-enforced service", async () => {
    const pool = { connect: vi.fn() };
    mocks.getPool.mockReturnValue(pool);
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({
      pool,
      actorUserId: 5,
      draftId: 41,
      expectedDictionaryVersion: 3,
      acceptedSuggestionIds: "safe",
      formatQuotes: false,
    }));
  });

  it("rejects unknown JSON fields instead of silently expanding authority", async () => {
    const malicious = new NextRequest("http://localhost/api/typography/apply", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ text: "Текст", projectId: 999 }),
    });
    const response = await POST(malicious);
    expect(response.status).toBe(400);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
