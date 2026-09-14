import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(() => ({ name: "pool" })),
  getSessionUser: vi.fn(),
  trustedOrigin: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => Response.json({ error: "rate_limited" }, { status: 429 })),
  decide: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.trustedOrigin }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/publication-review-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/publication-review-service")>();
  return { ...actual, decidePublicationReview: mocks.decide };
});

import { POST } from "./route";

function request(body: unknown, idempotencyKey = "decision-request-0001") {
  return new NextRequest("http://localhost/api/publication-review-tasks/9/decision", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/publication-review-tasks/:id/decision", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trustedOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 119 });
    mocks.decide.mockResolvedValue({
      reviewTaskId: 9,
      status: "completed",
      decision: "keep",
      version: 3,
      extraOperationId: null,
      extraStatus: null,
      replayed: false,
    });
  });

  it("checks origin before authentication or mutation", async () => {
    mocks.trustedOrigin.mockReturnValue(false);
    const response = await POST(request({}), { params: Promise.resolve({ id: "9" }) });
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("passes only the route id and server-authenticated actor to the service", async () => {
    const response = await POST(request({
      expectedVersion: 2,
      decision: "keep",
    }), { params: Promise.resolve({ id: "9" }) });
    expect(response.status).toBe(200);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      "publication-review:user:7",
      120,
      3_600,
      { failureMode: "closed" },
    );
    expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 7,
      reviewTaskId: "9",
      expectedVersion: 2,
      decision: "keep",
      idempotencyKey: "decision-request-0001",
    }));
    expect(mocks.decide.mock.calls[0]?.[0]).not.toHaveProperty("projectId");
  });

  it("rejects client-owned project scope and unknown fields", async () => {
    const response = await POST(request({
      expectedVersion: 2,
      decision: "keep",
      projectId: 999,
    }), { params: Promise.resolve({ id: "9" }) });
    expect(response.status).toBe(400);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("requires a valid idempotency key", async () => {
    const response = await POST(request({ expectedVersion: 2, decision: "keep" }, "bad"), {
      params: Promise.resolve({ id: "9" }),
    });
    expect(response.status).toBe(400);
    expect(mocks.decide).not.toHaveBeenCalled();
  });

  it("fails closed on rate-limit storage before parsing the body", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const req = new NextRequest("http://localhost/api/publication-review-tasks/9/decision", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "idempotency-key": "decision-request-rate-0001",
      },
      body: "{broken",
    });
    const response = await POST(req, { params: Promise.resolve({ id: "9" }) });
    expect(response.status).toBe(429);
    expect(mocks.decide).not.toHaveBeenCalled();
  });
});
