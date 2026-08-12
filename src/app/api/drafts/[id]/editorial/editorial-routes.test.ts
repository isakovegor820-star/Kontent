import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  trustedOrigin: vi.fn(),
  session: vi.fn(),
  rate: vi.fn(),
  rateResponse: vi.fn(),
  submit: vi.fn(),
  comment: vi.fn(),
  decide: vi.fn(),
}));

vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.trustedOrigin }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.rate,
  rateLimitResponse: mocks.rateResponse,
}));
vi.mock("@/lib/editorial-approval", async (original) => ({
  ...await original<typeof import("@/lib/editorial-approval")>(),
  submitDraftForEditorialReview: mocks.submit,
  addDraftEditorialComment: mocks.comment,
  decideDraftEditorialRequest: mocks.decide,
}));

import { POST as addComment } from "./comments/route";
import { POST as decide } from "./decisions/route";
import { POST as submit } from "./submit/route";

const HASH = "a".repeat(64);
const context = { params: Promise.resolve({ id: "41" }) };

function request(path: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.trustedOrigin.mockReturnValue(true);
  mocks.session.mockResolvedValue({ id: 5 });
  mocks.rate.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, retryAfter: 0 });
  mocks.rateResponse.mockImplementation(() => Response.json({ ok: false, error: "rate_limited" }, { status: 429 }));
  mocks.submit.mockResolvedValue({ workflow: { state: "in_review" }, request: { id: 12 } });
  mocks.comment.mockResolvedValue({ id: 21 });
  mocks.decide.mockResolvedValue({ workflow: { state: "approved" }, decisionId: 31 });
});

describe("editorial mutation routes", () => {
  it("rejects an untrusted origin before session, rate limit or service work", async () => {
    mocks.trustedOrigin.mockReturnValue(false);
    const response = await submit(request("/api/drafts/41/editorial/submit", {}), context);
    expect(response.status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.rate).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("rate-limits fail-closed before parsing or service work", async () => {
    mocks.rate.mockResolvedValue({ allowed: false, limit: 60, remaining: 0, retryAfter: 30, unavailable: true });
    const response = await submit(request("/api/drafts/41/editorial/submit", {}), context);
    expect(response.status).toBe(429);
    expect(mocks.rate).toHaveBeenCalledWith("editorial:submit:user:5", 60, 3_600, { failureMode: "closed" });
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("forwards only the exact submit revision contract", async () => {
    const body = { revisionId: 81, contentHash: HASH, workflowVersion: 2 };
    const response = await submit(request("/api/drafts/41/editorial/submit", body), context);
    expect(response.status).toBe(201);
    expect(mocks.submit).toHaveBeenCalledWith(5, 41, body);

    const unknownField = await submit(request("/api/drafts/41/editorial/submit", { ...body, projectId: 8 }), context);
    expect(unknownField.status).toBe(400);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
  });

  it("binds comments and decisions to exact revision and request versions", async () => {
    const commentBody = { revisionId: 81, contentHash: HASH, body: "Уточните источник." };
    const commentResponse = await addComment(request("/api/drafts/41/editorial/comments", commentBody), context);
    expect(commentResponse.status).toBe(201);
    expect(mocks.comment).toHaveBeenCalledWith(5, 41, commentBody);

    const decisionBody = {
      requestId: 12,
      requestVersion: 1,
      workflowVersion: 2,
      revisionId: 81,
      contentHash: HASH,
      decision: "request_changes",
      note: "Добавьте источник.",
    };
    const decisionResponse = await decide(request("/api/drafts/41/editorial/decisions", decisionBody), context);
    expect(decisionResponse.status).toBe(200);
    expect(mocks.decide).toHaveBeenCalledWith(5, 41, decisionBody);
  });
});
