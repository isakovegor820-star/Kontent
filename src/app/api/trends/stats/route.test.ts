import { ProjectRequest } from "@/test/project-request";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), session: vi.fn(), resolveChannel: vi.fn() }));
vi.mock("@/lib/project-permissions", async (original) => ({
  ...await original<typeof import("@/lib/project-permissions")>(),
  requireSelectedProjectPermission: vi.fn(async () => ({ projectId: 1 })),
}));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/autopilot", () => ({ resolveChannel: mocks.resolveChannel }));
import { GET } from "./route";
const payload = {
  summary: { posts: 12, sources: 3, views: null, reactions: null, avgViews: null, trends: 0, postsWithViews: 0, postsWithReactions: 0 },
  window: { from: "2026-09-01", to: "2026-09-08", timeZone: "Europe/Moscow" },
  coverage: { undatedPosts: 1, futurePosts: 0, oldestMeasurementAt: null, latestMeasurementAt: null, comparisonAvailable: false },
  search: null, series: [], topItems: [], items: [], status: {},
};
describe("GET /api/trends/stats", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.session.mockResolvedValue({ id: 7 }); mocks.resolveChannel.mockResolvedValue(11);
    mocks.query.mockResolvedValue({ rows: [{ payload }] });
  });
  it("keeps missing counters unavailable and returns one dataset for both views", async () => {
    const response = await GET(new ProjectRequest(1, "http://localhost/api/trends/stats?source=own&topic=Рыбалка&channel=11"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ topic: "рыбалка", summary: { views: null, reactions: null, avgViews: null },
      coverage: { comparisonAvailable: false }, items: [], pagination: { total: 12 } });
    expect(mocks.query.mock.calls[0][1]).toEqual([7, 11, 1, "рыбалка", null, 0]);
  });
  it("requires an owned project channel for private statistics", async () => {
    mocks.resolveChannel.mockResolvedValue(null);
    expect((await GET(new ProjectRequest(1, "http://localhost/api/trends/stats?source=internet&channel=999"))).status).toBe(422);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("cannot fall back to other results for an inaccessible or mismatched run", async () => {
    const response = await GET(new ProjectRequest(1, "http://localhost/api/trends/stats?source=internet&topic=рыбалка&run=99&channel=11"));
    expect(response.status).toBe(404);
  });
  it("does not require a channel for the shared collection", async () => {
    expect((await GET(new ProjectRequest(1, "http://localhost/api/trends/stats?source=collection"))).status).toBe(200);
    expect(mocks.resolveChannel).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls[0][1]).toEqual([7, null, 1, "", null, 0]);
  });
  it.each(["run=-2", "run=abc", "offset=-1", "offset=1.5", "offset=100001"])("rejects invalid filters: %s", async (query) => {
    expect((await GET(new ProjectRequest(1, `http://localhost/api/trends/stats?${query}`))).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
