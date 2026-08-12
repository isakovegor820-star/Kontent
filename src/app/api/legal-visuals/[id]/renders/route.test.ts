import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  requestLegalVisualRender: vi.fn(),
  reconcileLegalVisualRenderOutbox: vi.fn(),
  enqueueLegalVisualRenderJob: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/legal-visual-service", () => ({
  requestLegalVisualRender: mocks.requestLegalVisualRender,
}));
vi.mock("@/lib/legal-visual-render-outbox.mjs", () => ({
  reconcileLegalVisualRenderOutbox: mocks.reconcileLegalVisualRenderOutbox,
}));
vi.mock("@/lib/legal-visual-render-queue.mjs", () => ({
  enqueueLegalVisualRenderJob: mocks.enqueueLegalVisualRenderJob,
}));

import { POST } from "./route";

function request() {
  return new NextRequest("http://localhost/api/legal-visuals/9/renders", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedRevision: 2, idempotencyKey: "render-request-123" }),
  });
}

const context = { params: Promise.resolve({ id: "9" }) };

describe("POST /api/legal-visuals/:id/renders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.checkRateLimit.mockResolvedValue({
      allowed: true,
      limit: 30,
      remaining: 29,
      retryAfter: 0,
    });
    mocks.rateLimitResponse.mockImplementation((result: { unavailable?: boolean }) => NextResponse.json(
      { error: result.unavailable ? "rate_limit_unavailable" : "rate_limited" },
      { status: result.unavailable ? 503 : 429 },
    ));
  });

  it("fails closed at the render limiter before creating or dispatching work", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfter: 30,
      unavailable: true,
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "rate_limit_unavailable" });
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      "legal-visual-render:user:7",
      30,
      3_600,
      { failureMode: "closed" },
    );
    expect(mocks.requestLegalVisualRender).not.toHaveBeenCalled();
    expect(mocks.reconcileLegalVisualRenderOutbox).not.toHaveBeenCalled();
    expect(mocks.enqueueLegalVisualRenderJob).not.toHaveBeenCalled();
  });
});
