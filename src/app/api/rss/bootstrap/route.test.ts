import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  queueAdd: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: () => true }));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.queueAdd }) }));
vi.mock("@/lib/rss-catalog", () => ({
  listPublicLegalRssSources: () => [{ url: "https://law.test/rss", title: "Law" }],
}));

import { POST } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 5 });
  mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 17, userId: 5, role: "owner" });
  mocks.queueAdd.mockResolvedValue(undefined);
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("from channels")) return { rows: [{ id: "7" }], rowCount: 1 };
    if (sql.includes("bool_or(auto_publish_enabled)")) {
      return { rows: [{ enabled: false }], rowCount: 1 };
    }
    if (sql.includes("returning id")) return { rows: [{ id: "3" }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
});

describe("POST /api/rss/bootstrap", () => {
  it("does not carry auto-publish permission when sources move to another channel", async () => {
    const response = await POST(new NextRequest("http://localhost/api/rss/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId: 7 }),
    }));

    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      autoPublishEnabled: false,
    });
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("insert into rss_feeds"));
    expect(insert?.[0]).toContain("auto_publish_enabled = excluded.auto_publish_enabled");
    expect(insert?.[1]).toEqual([5, 7, "https://law.test/rss", "Law", false]);
  });
});
