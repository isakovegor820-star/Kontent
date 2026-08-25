import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  recoverDraftForUser: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/server-drafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-drafts")>();
  return { ...actual, recoverDraftForUser: mocks.recoverDraftForUser };
});

import { DraftConflictError, DraftValidationError } from "@/lib/server-drafts";
import { ProjectAccessError } from "@/lib/project-permissions";
import { POST } from "./route";

const body = {
  clientKey: "draft_recovery-12345678-1234-4234-9234-123456789abc",
  sourceVersion: 3,
  acceptResponsibility: true,
  text: "Принятый человеком текст",
  formatting: [],
  media: null,
  scheduledAt: null,
  schedule: null,
  channelIds: [11],
  tracking: null,
};
const recovered = {
  id: 99,
  version: 1,
  origin: "manual",
  purpose: "publishable",
  generation_result_id: null,
  ai_validation: null,
};

function request() {
  return new NextRequest("http://localhost/api/drafts/41/recover", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/drafts/:id/recover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
    mocks.recoverDraftForUser.mockResolvedValue({ draft: recovered, created: true });
  });

  it("creates a separate draft only after explicit responsibility acknowledgement", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(201);
    expect(mocks.recoverDraftForUser).toHaveBeenCalledWith(5, 41, expect.objectContaining({
      sourceVersion: 3,
      acceptResponsibility: true,
      text: body.text,
    }));
    await expect(response.json()).resolves.toMatchObject({ ok: true, created: true, draft: { id: 99 } });
  });

  it("returns the same draft on a replay instead of creating another copy", async () => {
    mocks.recoverDraftForUser.mockResolvedValue({ draft: recovered, created: false });
    const response = await POST(request(), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, created: false, draft: { id: 99 } });
  });

  it("returns the current source version after a concurrent edit", async () => {
    mocks.recoverDraftForUser.mockRejectedValue(new DraftConflictError({ id: 41, version: 4 } as never));
    const response = await POST(request(), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "version_conflict",
      current: { id: 41, version: 4 },
    });
  });

  it("rejects cross-origin and unconfirmed recovery requests before mutation", async () => {
    const crossOrigin = new NextRequest("http://localhost/api/drafts/41/recover", {
      method: "POST",
      headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      body: JSON.stringify(body),
    });
    expect((await POST(crossOrigin, { params: Promise.resolve({ id: "41" }) })).status).toBe(403);
    expect(mocks.recoverDraftForUser).not.toHaveBeenCalled();

    const unconfirmed = new NextRequest("http://localhost/api/drafts/41/recover", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ ...body, acceptResponsibility: false }),
    });
    expect((await POST(unconfirmed, { params: Promise.resolve({ id: "41" }) })).status).toBe(422);
    expect(mocks.recoverDraftForUser).not.toHaveBeenCalled();
  });

  it("keeps recovery inside the selected project and content-create role boundary", async () => {
    mocks.recoverDraftForUser.mockRejectedValue(new ProjectAccessError("permission_denied"));
    const response = await POST(request(), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "access_denied" });
  });

  it("keeps a validation takeover server-gated when the selected project is not personal", async () => {
    mocks.recoverDraftForUser.mockRejectedValue(
      new DraftValidationError("validation_blocked_requires_new_check"),
    );
    const response = await POST(request(), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "validation_blocked_requires_new_check",
    });
  });
});
