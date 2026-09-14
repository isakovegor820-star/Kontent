import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  trusted: vi.fn(),
  session: vi.fn(),
  permission: vi.fn(),
  buildContext: vi.fn(),
  createDraft: vi.fn(),
}));

vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.trusted }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn(), connect: vi.fn() }) }));
vi.mock("@/lib/project-permissions", () => ({
  ProjectAccessError: class ProjectAccessError extends Error {},
  requireSelectedProjectPermission: mocks.permission,
}));
vi.mock("@/lib/library-drafts", () => ({
  LibraryDraftError: class LibraryDraftError extends Error { constructor(public code: string) { super(code); } },
  buildServerLibraryDraftContext: mocks.buildContext,
}));
vi.mock("@/lib/server-drafts", () => ({
  DraftValidationError: class DraftValidationError extends Error { constructor(public code: string) { super(code); } },
  createDraftForUser: mocks.createDraft,
}));

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("https://aurora.test/api/library/drafts", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://aurora.test" },
    body: JSON.stringify(body),
  }) as never;
}

describe("POST /api/library/drafts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trusted.mockReturnValue(true);
    mocks.session.mockResolvedValue({ id: 7 });
    mocks.permission.mockResolvedValue({ projectId: 3 });
    mocks.buildContext.mockResolvedValue({ text: "Серверный текст" });
    mocks.createDraft.mockResolvedValue({ created: true, draft: { id: 81 } });
  });

  it("creates a draft from a server-owned item and returns a request id", async () => {
    const response = await POST(request({
      itemKey: "reference:41",
      channelId: 11,
      clientKey: "draft_library-reference-1234567890",
    }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ ok: true, created: true, draft: { id: 81 }, requestId: expect.any(String) });
    expect(mocks.buildContext).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7, projectId: 3, channelId: 11, itemKey: "reference:41",
    }));
  });

  it("rejects an untrusted origin without touching user data", async () => {
    mocks.trusted.mockReturnValue(false);
    const response = await POST(request({ itemKey: "reference:41", channelId: 11, clientKey: "draft_x" }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden_origin", requestId: expect.any(String) });
    expect(mocks.session).not.toHaveBeenCalled();
  });
});
