import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  createDraftForUser: vi.fn(),
  listDraftsForUser: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/server-drafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-drafts")>();
  return {
    ...actual,
    createDraftForUser: mocks.createDraftForUser,
    listDraftsForUser: mocks.listDraftsForUser,
  };
});

import { POST } from "./route";

const body = {
  clientKey: "draft_12345678-1234-4234-9234-123456789abc",
  text: "Черновик",
  media: null,
  scheduledAt: null,
  origin: "manual",
  sourceRef: null,
  channelIds: [11],
};

const draft = {
  id: 41,
  text: body.text,
  media: null,
  scheduled_at: null,
  origin: "manual" as const,
  source_ref: null,
  client_key: body.clientKey,
  version: 1,
  created_at: "2026-08-01T10:00:00.000Z",
  updated_at: "2026-08-01T10:00:00.000Z",
  destinations: [],
};

describe("POST /api/drafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
    mocks.createDraftForUser.mockResolvedValue({ draft, created: true });
  });

  it("requires a session before touching the model", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await POST(new NextRequest("http://localhost/api/drafts", {
      method: "POST",
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(401);
    expect(mocks.createDraftForUser).not.toHaveBeenCalled();
  });

  it("returns 200 and the same draft for an idempotency replay", async () => {
    mocks.createDraftForUser.mockResolvedValue({ draft, created: false });
    const response = await POST(new NextRequest("http://localhost/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, created: false, draft: { id: 41 } });
    expect(mocks.createDraftForUser).toHaveBeenCalledWith(5, expect.objectContaining({ channelIds: [11] }));
  });

  it("accepts Library reference context in the JSON body without query-carried content", async () => {
    const referenceBody = {
      ...body,
      clientKey: "draft_library-reference-1234567890",
      text: "Полный текст референса с фактами",
      origin: "competitor",
      sourceRef: { kind: "competitor", id: "9", label: "Канал конкурента" },
      aiValidation: null,
      generationResultId: null,
    };
    const request = new NextRequest("http://localhost/api/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(referenceBody),
    });

    const response = await POST(request);

    expect(response.status).toBe(201);
    expect(request.nextUrl.search).toBe("");
    expect(mocks.createDraftForUser).toHaveBeenCalledWith(5, referenceBody);
  });
});
