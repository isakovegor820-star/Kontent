import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { ProjectAccessError } from "@/lib/project-permissions";
const mocks = vi.hoisted(() => ({ session: vi.fn(), permission: vi.fn(), query: vi.fn(), connect: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query, connect: mocks.connect }) }));
vi.mock("@/lib/project-permissions", async (load) => ({
  ...await load<typeof import("@/lib/project-permissions")>(), requireSelectedProjectPermission: mocks.permission, requireProjectPermission: mocks.permission,
}));
type Handler = (request: NextRequest, context: { params: Promise<{ id: string; articleId: string; reportId: string }> }) => Promise<Response>;
const routes: Array<[string, string, () => Promise<unknown>]> = [
  ["sites/[id]/analyze", "POST", () => import("./[id]/analyze/route")],
  ["sites/[id]/articles/[articleId]", "GET", () => import("./[id]/articles/[articleId]/route")],
  ["sites/[id]/articles/[articleId]", "PATCH", () => import("./[id]/articles/[articleId]/route")],
  ["sites/[id]/articles/[articleId]", "POST", () => import("./[id]/articles/[articleId]/route")],
  ["sites/[id]/articles", "GET", () => import("./[id]/articles/route")],
  ["sites/[id]/articles", "POST", () => import("./[id]/articles/route")],
  ["sites/[id]/destinations", "GET", () => import("./[id]/destinations/route")],
  ["sites/[id]/destinations", "PUT", () => import("./[id]/destinations/route")],
  ["sites/[id]/destinations", "DELETE", () => import("./[id]/destinations/route")],
  ["sites/[id]/probe", "GET", () => import("./[id]/probe/route")],
  ["sites/[id]/probe", "POST", () => import("./[id]/probe/route")],
  ["sites/[id]/reports/[reportId]/export", "GET", () => import("./[id]/reports/[reportId]/export/route")],
  ["sites/[id]/reports", "GET", () => import("./[id]/reports/route")],
  ["sites/[id]/reports", "POST", () => import("./[id]/reports/route")],
  ["sites/[id]", "GET", () => import("./[id]/route")],
  ["sites/[id]/settings", "PATCH", () => import("./[id]/settings/route")],
  ["sites/[id]/verify", "POST", () => import("./[id]/verify/route")],
  ["sites", "GET", () => import("./route")],
  ["sites", "POST", () => import("./route")],
];
function request(route: string, method: string, origin = "http://localhost") {
  return new NextRequest(`http://localhost/api/${route.replace(/\[[^\]]+\]/gu, "1")}`, { method, headers: { origin, cookie: "sid=synthetic", "x-aurora-project-id": "1" }, ...(method === "GET" ? {} : { body: "{}" }) });
}
const context = () => ({ params: Promise.resolve({ id: "1", articleId: "1", reportId: "1" }) });
beforeEach(() => { vi.clearAllMocks(); mocks.session.mockResolvedValue(null); });
describe.each(routes)("Sites authorization %s %s", (route, method, load) => {
  it("rejects unauthenticated requests before repository or provider work", async () => {
    const handler = (await load() as Record<string, Handler>)[method];
    expect((await handler(request(route, method), context())).status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
  });
  it("rejects revoked selected membership before reading or writing site resources", async () => {
    mocks.session.mockResolvedValue({ id: 1 });
    mocks.permission.mockRejectedValue(new ProjectAccessError("membership_required"));
    const handler = (await load() as Record<string, Handler>)[method];
    expect((await handler(request(route, method), context())).status).toBe(403);
    expect(mocks.permission).toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
  });
  if (method !== "GET") it("rejects cross-origin cookie mutation before authentication or side effects", async () => {
    const handler = (await load() as Record<string, Handler>)[method];
    expect((await handler(request(route, method, "https://attacker.example"), context())).status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
  });
});
