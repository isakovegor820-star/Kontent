import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  updateDraftForUser: vi.fn(),
  getDraftForUser: vi.fn(),
  deleteDraftForUser: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/server-drafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-drafts")>();
  return {
    ...actual,
    updateDraftForUser: mocks.updateDraftForUser,
    getDraftForUser: mocks.getDraftForUser,
    deleteDraftForUser: mocks.deleteDraftForUser,
  };
});

import { DraftConflictError } from "@/lib/server-drafts";
import { PATCH } from "./route";

const current = {
  id: 41,
  text: "Более свежий текст",
  media: null,
  scheduled_at: null,
  origin: "manual" as const,
  purpose: "publishable" as const,
  source_ref: null,
  generation_result_id: null,
  generation_binding_valid: false,
  client_key: "draft_12345678-1234-4234-9234-123456789abc",
  version: 3,
  review_policy_version: 1 as const,
  ai_validation: null,
  human_review: null,
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-01T12:00:00.000Z",
  destinations: [],
};

describe("PATCH /api/drafts/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
  });

  it("returns 409 with the current server draft for a stale version", async () => {
    mocks.updateDraftForUser.mockRejectedValue(new DraftConflictError(current));
    const response = await PATCH(
      new NextRequest("http://localhost/api/drafts/41", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: "Старая правка",
          media: null,
          scheduledAt: null,
          origin: "manual",
          sourceRef: null,
          channelIds: [11],
          version: 2,
        }),
      }),
      { params: Promise.resolve({ id: "41" }) },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "version_conflict",
      current: { id: 41, version: 3 },
    });
  });
});
