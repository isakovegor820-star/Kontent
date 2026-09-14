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

function request(body: unknown) {
  return new NextRequest("http://localhost/api/rss/items/41/state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 5 });
  mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 17, userId: 5, role: "owner" });
});

describe("POST /api/rss/items/:id/state", () => {
  it("persists reading separately for the selected user and project", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: "41" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ read_at: "2026-08-14T10:00:00.000Z" }], rowCount: 1 });

    const response = await POST(request({ viewed: true }), { params: Promise.resolve({ id: "41" }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      readAt: "2026-08-14T10:00:00.000Z",
    });
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("legal_opportunity_reads"),
      [5, 17, 41],
    );
  });

  it("marks an explicit card action as read in the same request", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: "41" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ read_at: "2026-08-14T10:00:00.000Z" }], rowCount: 1 });

    const response = await POST(request({ state: "dismissed" }), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, state: "dismissed" });
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("legal_opportunity_states"),
      [5, 41, "dismissed"],
    );
    expect(mocks.query).toHaveBeenCalledTimes(3);
  });

  it("does not expose an item outside the selected project", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const response = await POST(request({ viewed: true }), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(404);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });
});

