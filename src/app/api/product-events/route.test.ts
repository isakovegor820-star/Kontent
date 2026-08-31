import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  hasTrustedMutationOrigin: vi.fn(),
  getSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  persistAuroraProductEvents: vi.fn(),
  maybePruneExpiredProductEvents: vi.fn(),
}));

vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...original, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/product-events", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/product-events")>();
  return {
    ...original,
    persistAuroraProductEvents: mocks.persistAuroraProductEvents,
    maybePruneExpiredProductEvents: mocks.maybePruneExpiredProductEvents,
  };
});

import { POST } from "./route";

const now = new Date().toISOString();
const safeEvent = {
  eventId: "11111111-1111-4111-8111-111111111111",
  sectionId: "studio",
  featureId: "generation",
  action: "requested",
  stage: "started",
  outcome: "pending",
  occurredAt: now,
  safeContext: { device: "desktop", source: "ui" },
};

function request(body: unknown) {
  return new NextRequest("http://localhost/api/product-events", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      cookie: "sid=session",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/product-events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 7, email: "user@example.test" });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 31, userId: 7, role: "owner" });
    mocks.persistAuroraProductEvents.mockResolvedValue({ accepted: 1, replayed: 0, release: null });
    mocks.maybePruneExpiredProductEvents.mockResolvedValue(0);
  });

  it("binds user and project on the server and returns no-store", async () => {
    const result = await POST(request({ events: [safeEvent] }));
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(expect.anything(), 7, "project.read");
    expect(mocks.persistAuroraProductEvents).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 7,
      projectId: 31,
      events: [expect.objectContaining({ sectionId: "studio", featureId: "generation" })],
    }));
  });

  it("rejects client tenant identity, content and arbitrary metadata", async () => {
    for (const extra of [
      { userId: 99 },
      { projectId: 99 },
      { important: false },
      { safeContext: { content: "private post" } },
      { metadata: { anything: true } },
    ]) {
      const result = await POST(request({ events: [{ ...safeEvent, ...extra }] }));
      expect(result.status).toBe(400);
    }
    expect(mocks.persistAuroraProductEvents).not.toHaveBeenCalled();
  });

  it("requires origin, session and fail-closed rate limit before storage", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValueOnce(false);
    expect((await POST(request({ events: [safeEvent] }))).status).toBe(403);

    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await POST(request({ events: [safeEvent] }))).status).toBe(401);

    mocks.checkRateLimit.mockResolvedValueOnce({
      allowed: false, limit: 240, remaining: 0, retryAfter: 30, unavailable: true,
    });
    mocks.rateLimitResponse.mockReturnValueOnce(new Response(JSON.stringify({ error: "rate_limit_unavailable" }), {
      status: 503,
    }));
    const limited = await POST(request({ events: [safeEvent] }));
    expect(limited.status).toBe(503);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(mocks.persistAuroraProductEvents).not.toHaveBeenCalled();
  });

  it("rejects oversized or extra-root batches", async () => {
    expect((await POST(request({ events: [safeEvent], projectId: 31 }))).status).toBe(400);
    expect((await POST(request({ events: [] }))).status).toBe(400);
    expect((await POST(request({ events: Array.from({ length: 51 }, () => safeEvent) }))).status).toBe(400);
  });
});
