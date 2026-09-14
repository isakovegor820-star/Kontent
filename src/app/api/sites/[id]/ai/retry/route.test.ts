import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ session: vi.fn(), origin: vi.fn(), permission: vi.fn(), query: vi.fn(), enqueue: vi.fn(), worker: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.origin }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/project-permissions", async (original) => ({ ...await original<typeof import("@/lib/project-permissions")>(), requireSelectedProjectPermission: mocks.permission }));
vi.mock("@/lib/site-articles-queue", () => ({ enqueueSiteArticleJob: mocks.enqueue, hasSiteArticlesWorker: mocks.worker }));
import { POST } from "./route";
const site = { id: 5, project_id: 31, user_id: 7, latest_profile_id: 77, status: "active" };
const run = (body: unknown) => POST(new NextRequest("http://localhost/api/sites/5/ai/retry", {
  method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "5" }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ id: 7 }); mocks.origin.mockReturnValue(true);
  mocks.permission.mockResolvedValue({ projectId: 31, userId: 7, role: "owner", version: 1 });
  mocks.worker.mockResolvedValue(true); mocks.enqueue.mockResolvedValue(true);
  mocks.query.mockImplementation(async (sql: string) => sql.includes("from sites where") ? { rows: [site] } : { rows: [] });
});

describe("site AI retry authorization and state", () => {
  it("requires a session and trusted origin before changing tasks", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await run({ target: "profile" })).status).toBe(401);
    mocks.session.mockResolvedValue({ id: 7 }); mocks.origin.mockReturnValue(false);
    expect((await run({ target: "profile" })).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("hides another project's site and does not enqueue", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    expect((await run({ target: "profile" })).status).toBe(404);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("project_id = $2"), [5,31]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("requires an available worker and a failed task", async () => {
    mocks.worker.mockResolvedValue(false);
    expect((await run({ target: "profile" })).status).toBe(503);
    mocks.worker.mockResolvedValue(true);
    expect((await run({ target: "profile" })).status).toBe(409);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("uses the report revision returned by the atomic transition", async () => {
    mocks.query.mockImplementation(async (sql: string) => sql.includes("from sites where") ? { rows: [site] } : { rows: [{ interpretation_revision: 4 }] });
    expect((await run({ target: "report", reportId: 12 })).status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith("interpret", { reportId: 12, revision: 4 }, { jobId: "site-interpretation-12-v4" });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("interpretation_status = 'failed'"), [12,5]);
  });
  it("enqueues only the failed current profile and refuses a second transition", async () => {
    let changed = false;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from sites where")) return { rows: [site] };
      if (changed) return { rows: [] };
      changed = true; return { rows: [{ id: 77 }] };
    });
    expect((await run({ target: "profile" })).status).toBe(202);
    expect((await run({ target: "profile" })).status).toBe(409);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).toHaveBeenCalledWith("refine", { profileId: 77 }, expect.any(Object));
  });
});
