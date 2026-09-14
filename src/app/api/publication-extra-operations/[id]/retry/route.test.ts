import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(() => ({ name: "pool" })),
  getSessionUser: vi.fn(),
  trustedOrigin: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => Response.json({ error: "rate_limited" }, { status: 429 })),
  retry: vi.fn(),
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
  return { ...actual, retryPublicationExtraOperation: mocks.retry };
});

import { PublicationReviewError } from "@/lib/publication-review-service";
import { POST } from "./route";

function request(body: unknown, idempotencyKey = "extra-retry-request-0001") {
  return new NextRequest("http://localhost/api/publication-extra-operations/77/retry", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/publication-extra-operations/:id/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trustedOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, remaining: 59 });
    mocks.retry.mockResolvedValue({ operationId: 77, status: "pending", replayed: false });
  });

  it("passes explicit absence confirmation to the project-scoped service", async () => {
    const expectedFingerprint = "a".repeat(64);
    const response = await POST(request({ expectedFingerprint, verifiedAbsent: true }), {
      params: Promise.resolve({ id: "77" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.retry).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 7,
      operationId: "77",
      expectedFingerprint,
      verifiedAbsent: true,
      idempotencyKey: "extra-retry-request-0001",
    }));
    expect(mocks.retry.mock.calls[0]?.[0]).not.toHaveProperty("projectId");
  });

  it("rejects client-owned project scope and unknown fields", async () => {
    const response = await POST(request({
      expectedFingerprint: "a".repeat(64),
      projectId: 999,
    }), { params: Promise.resolve({ id: "77" }) });
    expect(response.status).toBe(400);
    expect(mocks.retry).not.toHaveBeenCalled();
  });

  it("returns a visible conflict when Telegram absence was not confirmed", async () => {
    mocks.retry.mockRejectedValue(new PublicationReviewError("provider_confirmation_required"));
    const response = await POST(request({ expectedFingerprint: "a".repeat(64) }), {
      params: Promise.resolve({ id: "77" }),
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "provider_confirmation_required",
    });
  });

  it("does not authenticate an untrusted mutation", async () => {
    mocks.trustedOrigin.mockReturnValue(false);
    const response = await POST(request({}), { params: Promise.resolve({ id: "77" }) });
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  it("fails closed on rate-limit storage before parsing the body", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const req = new NextRequest("http://localhost/api/publication-extra-operations/77/retry", {
      method: "POST",
      headers: {
        origin: "http://localhost",
        "content-type": "application/json",
        "idempotency-key": "extra-retry-rate-0001",
      },
      body: "{broken",
    });
    const response = await POST(req, { params: Promise.resolve({ id: "77" }) });
    expect(response.status).toBe(429);
    expect(mocks.retry).not.toHaveBeenCalled();
  });
});
