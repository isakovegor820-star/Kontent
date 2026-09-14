import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: () => true }));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});

import { POST } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 5 });
  mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 17, userId: 5, role: "owner" });
  mocks.query.mockResolvedValue({ rows: [{ rss_item_id: "1" }], rowCount: 4 });
});

describe("POST /api/rss/read-all", () => {
  it("marks all visible project items as read without accepting a client project id", async () => {
    const response = await POST(new NextRequest("http://localhost/api/rss/read-all", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, projectId: 17, markedCount: 4, unreadCount: 0 });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("channel.project_id = $2"),
      [5, 17, expect.any(Date)],
    );
  });
});
