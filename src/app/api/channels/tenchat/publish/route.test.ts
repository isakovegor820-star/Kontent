import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn() }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/project-permissions", () => ({
  ProjectAccessError: class ProjectAccessError extends Error {},
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));

import { POST } from "./route";

function request() {
  return new NextRequest("http://localhost/api/channels/tenchat/publish", {
    method: "POST",
    headers: { origin: "http://localhost" },
  });
}

describe("POST /api/channels/tenchat/publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 31 });
  });

  it("is a terminal official-access path and performs no external I/O", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const response = await POST(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "official_access_required",
      code: "tenchat_official_access_required",
      terminal: true,
      retryable: false,
      livePublished: false,
      exportAvailable: true,
      exportUrl: "/api/channels/tenchat/export",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects an untrusted origin before session lookup", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValue(false);
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });
});
