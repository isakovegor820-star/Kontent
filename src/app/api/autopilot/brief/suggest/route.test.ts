import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  resolveChannel: vi.fn(),
  query: vi.fn(),
  fetchPublicPosts: vi.fn(),
  reserveAiUsage: vi.fn(),
  completeAiText: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/autopilot", () => ({ resolveChannel: mocks.resolveChannel }));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});
vi.mock("@/lib/tg-public", () => ({ fetchPublicPosts: mocks.fetchPublicPosts }));
vi.mock("@/lib/ai-usage", () => ({
  reserveAiUsage: mocks.reserveAiUsage,
  commitAiUsage: vi.fn(),
  releaseAiUsage: vi.fn(),
}));
vi.mock("@/lib/ai-completion-service.mjs", () => ({ completeAiText: mocks.completeAiText }));

import { POST } from "./route";

function request(channelId: number) {
  return new NextRequest("http://localhost/api/autopilot/brief/suggest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channelId }),
  });
}

describe("POST /api/autopilot/brief/suggest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 4 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 88,
      userId: 4,
      role: "author",
      version: 1,
    });
  });

  it("does not read or bill for a project A channel while project B is selected", async () => {
    mocks.resolveChannel.mockResolvedValue(null);

    const response = await POST(request(99));

    expect(response.status).toBe(422);
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.objectContaining({ query: mocks.query }),
      4,
      "content.create",
    );
    expect(mocks.resolveChannel).toHaveBeenCalledWith(
      { actorUserId: 4, projectId: 88 },
      99,
    );
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.fetchPublicPosts).not.toHaveBeenCalled();
    expect(mocks.reserveAiUsage).not.toHaveBeenCalled();
    expect(mocks.completeAiText).not.toHaveBeenCalled();
  });
});
