import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ProjectAccessError } from "@/lib/project-permissions";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  attestDraftReviewForUser: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/server-drafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-drafts")>();
  return {
    ...actual,
    attestDraftReviewForUser: mocks.attestDraftReviewForUser,
  };
});

import { DraftConflictError } from "@/lib/server-drafts";
import { POST } from "./route";

const reviewedDraft = {
  id: 41,
  text: "Проверенный AI-текст",
  media: null,
  scheduled_at: "2026-08-05T10:00:00.000Z",
  origin: "ai" as const,
  purpose: "needs_review" as const,
  source_ref: null,
  generation_result_id: 81,
  generation_binding_valid: false,
  client_key: "draft_12345678-1234-4234-9234-123456789abc",
  version: 4,
  review_policy_version: 1 as const,
  ai_validation: null,
  human_review: {
    policy_version: 1 as const,
    draft_version: 4,
    attested_at: "2026-08-01T12:05:00.000Z",
  },
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-01T12:05:00.000Z",
  destinations: [],
};

function request(version: number) {
  return new NextRequest("http://localhost/api/drafts/41/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
  });
}

describe("POST /api/drafts/:id/review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
  });

  it("returns the server ACK whose attestation is bound to the new version", async () => {
    mocks.attestDraftReviewForUser.mockResolvedValue(reviewedDraft);

    const response = await POST(request(3), { params: Promise.resolve({ id: "41" }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      draft: {
        id: 41,
        version: 4,
        human_review: { policy_version: 1, draft_version: 4 },
      },
    });
    expect(mocks.attestDraftReviewForUser).toHaveBeenCalledWith(5, 41, 3);
  });

  it("returns the newer server draft when another tab won the version race", async () => {
    const current = {
      ...reviewedDraft,
      version: 5,
      human_review: null,
      text: "Изменено в другой вкладке",
    };
    mocks.attestDraftReviewForUser.mockRejectedValue(new DraftConflictError(current));

    const response = await POST(request(3), { params: Promise.resolve({ id: "41" }) });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "version_conflict",
      current: { id: 41, version: 5, human_review: null },
    });
  });

  it("rejects an invalid version before mutating the draft", async () => {
    const response = await POST(request(0), { params: Promise.resolve({ id: "41" }) });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "bad_version" });
    expect(mocks.attestDraftReviewForUser).not.toHaveBeenCalled();
  });

  it("returns access denied for a role without edit permission", async () => {
    mocks.attestDraftReviewForUser.mockRejectedValue(new ProjectAccessError("permission_denied"));
    const response = await POST(request(3), { params: Promise.resolve({ id: "41" }) });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "access_denied" });
  });

  it("rejects cross-origin review before reading the session", async () => {
    const response = await POST(new NextRequest("http://localhost/api/drafts/41/review", {
      method: "POST",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ version: 3 }),
    }), { params: Promise.resolve({ id: "41" }) });

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.attestDraftReviewForUser).not.toHaveBeenCalled();
  });
});
