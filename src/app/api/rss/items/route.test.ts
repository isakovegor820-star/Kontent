import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});

import { GET } from "./route";

const rows = [
  {
    id: "41",
    feed_id: "9",
    channel_id: "7",
    channel_title: "Основной канал",
    title: "Новые налоговые правила вступают в силу",
    summary: "Компаниям нужно проверить срок подачи декларации.",
    link: "https://example.com/41",
    published_at: "2026-08-14T09:00:00.000Z",
    fetched_at: "2026-08-14T09:05:00.000Z",
    status: "new",
    skip_reason: null,
    post_id: null,
    post_status: null,
    feed_title: "ГАРАНТ.РУ",
    feed_url: "https://example.com/rss",
    opportunity_state: null,
    read_at: null,
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 5 });
  mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 17, userId: 5, role: "owner" });
  mocks.query.mockResolvedValue({ rows, rowCount: rows.length });
});

describe("GET /api/rss/items", () => {
  it("returns a project-scoped unread summary for the navigation badge", async () => {
    const response = await GET(new NextRequest("http://localhost/api/rss/items?summary=unread"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ projectId: 17, unreadCount: 1 });
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(expect.anything(), 5, "project.read");
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("c.project_id = $2"),
      [5, 17, null],
    );
    expect(mocks.query.mock.calls[0]?.[0]).not.toContain("limit 60");
  });

  it("includes persisted read state in the full item contract", async () => {
    mocks.query.mockResolvedValue({
      rows: [{ ...rows[0], read_at: "2026-08-14T10:00:00.000Z" }],
      rowCount: 1,
    });
    const response = await GET(new NextRequest("http://localhost/api/rss/items?channelId=7"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ projectId: 17, unreadCount: 0 });
    expect(body.items[0]).toMatchObject({ id: 41, channel_id: 7, read_at: "2026-08-14T10:00:00.000Z" });
    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), [5, 17, 7]);
    expect(mocks.query.mock.calls[0]?.[0]).toContain("limit 60");
  });

  it("rejects unsupported summary modes", async () => {
    const response = await GET(new NextRequest("http://localhost/api/rss/items?summary=all"));
    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
