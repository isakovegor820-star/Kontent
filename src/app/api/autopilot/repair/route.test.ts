import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  resolveChannel: vi.fn(),
  poolQuery: vi.fn(),
  txQuery: vi.fn(),
  release: vi.fn(),
  queueAdd: vi.fn(),
  getWorkersCount: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});
vi.mock("@/lib/autopilot", () => ({ resolveChannel: mocks.resolveChannel }));
vi.mock("@/lib/db", () => ({
  getPool: () => ({
    query: mocks.poolQuery,
    connect: async () => ({ query: mocks.txQuery, release: mocks.release }),
  }),
}));
vi.mock("@/lib/queue", () => ({
  getAutopilotQueue: () => ({ add: mocks.queueAdd, getWorkersCount: mocks.getWorkersCount }),
}));

import { POST } from "./route";

const jobId = "4df56d36-7799-46aa-a35b-5f2a1ee0a8c4";
const failedItems = [
  { i: 0, status: "pending", aiReady: false, buildState: "failed" },
  { i: 1, status: "pending", aiReady: false, buildState: "failed" },
];

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/autopilot/repair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { planId: 91, revision: 4, channelId: 22, jobId, itemIndexes: [1], ...overrides };
}

describe("POST /api/autopilot/repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 4 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 88, role: "author" });
    mocks.resolveChannel.mockResolvedValue(22);
    mocks.getWorkersCount.mockResolvedValue(1);
    mocks.queueAdd.mockResolvedValue({ id: "repair-job" });
    mocks.txQuery.mockImplementation(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/gu, " ").trim();
      if (sql.includes("from autopilot_plan")) {
        return {
          rows: [{
            id: 91,
            revision: 4,
            status: "partial",
            items: failedItems,
            repair_strategy: "rewrite",
            repair_attempt: 0,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("where project_id = $1 and job_id")) return { rows: [], rowCount: 0 };
      if (sql.includes("status in ('queued', 'processing')")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("insert into autopilot_repair_operations")) {
        return { rows: [{ id: 701 }], rowCount: 1 };
      }
      if (sql.startsWith("update autopilot_plan")) {
        return { rows: [{ revision: 5 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
  });

  it("scopes the repair to project, channel, plan revision, and selected indexes", async () => {
    const response = await POST(request(validBody()));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, planId: 91, revision: 5, itemIndexes: [1] });
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(expect.anything(), 4, "content.create");
    expect(mocks.resolveChannel).toHaveBeenCalledWith({ actorUserId: 4, projectId: 88 }, 22);
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "autopilot-repair",
      expect.objectContaining({ projectId: 88, channelId: 22, planId: 91, repairIndexes: [1] }),
      expect.objectContaining({ jobId: `autopilot-repair-88-${jobId}` }),
    );
    const planLookup = mocks.txQuery.mock.calls.find(([sql]) => String(sql).includes("from autopilot_plan"));
    expect(planLookup?.[1]).toEqual([91, 88, 22]);
  });

  it("caps repair to the missing publication count instead of spending quota on the reserve", async () => {
    const response = await POST(request(validBody({ itemIndexes: [0, 1] })));
    const body = await response.json();

    expect(body).toMatchObject({ ok: true, itemIndexes: [0] });
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "autopilot-repair",
      expect.objectContaining({ repairIndexes: [0] }),
      expect.anything(),
    );
  });

  it("returns a safe not-found response for a plan outside the selected project", async () => {
    mocks.txQuery.mockImplementation(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/gu, " ").trim();
      if (sql.includes("from autopilot_plan")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    const response = await POST(request(validBody({ planId: 999 })));
    await expect(response.json()).resolves.toEqual({ ok: false, error: "not_found" });
    expect(response.status).toBe(404);
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("rejects an untrusted mutation origin before reading session state", async () => {
    const response = await POST(new NextRequest("http://localhost/api/autopilot/repair", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify(validBody()),
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "forbidden_origin" });
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  it("returns a safe not-found response for a channel outside the selected project", async () => {
    mocks.resolveChannel.mockResolvedValue(null);

    const response = await POST(request(validBody({ channelId: 999 })));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "not_found" });
    expect(mocks.txQuery).not.toHaveBeenCalled();
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("rejects a stale revision without creating an operation", async () => {
    const response = await POST(request(validBody({ revision: 3 })));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "revision_conflict" });
    expect(mocks.txQuery.mock.calls.some(([sql]) => String(sql).startsWith("insert into autopilot_repair_operations")))
      .toBe(false);
  });

  it("replays the same job id and never enqueues a parallel duplicate", async () => {
    mocks.txQuery.mockImplementation(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/gu, " ").trim();
      if (sql.includes("from autopilot_plan")) {
        return {
          rows: [{
            id: 91,
            revision: 4,
            status: "partial",
            items: failedItems,
            repair_strategy: "rewrite",
            repair_attempt: 0,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("where project_id = $1 and job_id")) {
        const { createHash } = await import("node:crypto");
        const requestHash = createHash("sha256")
          .update(JSON.stringify({ projectId: 88, channelId: 22, planId: 91, revision: 4, indexes: [1] }), "utf8")
          .digest("hex");
        return {
          rows: [{
            id: 701,
            source_plan_id: 91,
            channel_id: 22,
            base_revision: 4,
            item_indexes: [1],
            request_hash: requestHash,
            status: "processing",
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const response = await POST(request(validBody()));
    await expect(response.json()).resolves.toMatchObject({ ok: true, replayed: true, operationId: 701 });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
    expect(mocks.txQuery.mock.calls.some(([sql]) => String(sql).includes("from autopilot_plan")))
      .toBe(false);
  });

  it("does not create a parallel repair under a different job id", async () => {
    mocks.txQuery.mockImplementation(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/gu, " ").trim();
      if (sql.includes("where project_id = $1 and job_id")) return { rows: [], rowCount: 0 };
      if (sql.includes("from autopilot_plan")) {
        return {
          rows: [{
            id: 91,
            revision: 4,
            status: "partial",
            items: failedItems,
            repair_strategy: "rewrite",
            repair_attempt: 0,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("from autopilot_repair_operations") && sql.includes("status in ('queued', 'processing')")) {
        return { rows: [{ id: 700 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    const response = await POST(request(validBody({
      jobId: "ea0334ef-828e-4b8a-bd24-1901ef1828dc",
    })));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "repair_in_progress" });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });
});
