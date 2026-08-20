import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getSessionUser: vi.fn(), query: vi.fn(), requireSelectedProjectPermission: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/project-permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/project-permissions")>(),
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));

import { GET } from "./route";

describe("GET /api/site-analysis/:id/compare", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 31, userId: 7, role: "owner", version: 1 });
  });

  it("compares two stored run revisions without inventing missing answers", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ run_revision: 2, request_id: "req-41" }] })
      .mockResolvedValueOnce({ rows: [
        { run_revision: 2, question_id: "a", status: "answered", confidence: "high", short_answer: "new", evidence_keys: ["ev-2"] },
        { run_revision: 2, question_id: "b", status: "answered", confidence: "medium", short_answer: "same", evidence_keys: ["ev-b"] },
        { run_revision: 2, question_id: "c", status: "hypothesis", confidence: "low", short_answer: "added", evidence_keys: ["ev-c"] },
        { run_revision: 1, question_id: "a", status: "hypothesis", confidence: "low", short_answer: "old", evidence_keys: ["ev-1"] },
        { run_revision: 1, question_id: "b", status: "answered", confidence: "medium", short_answer: "same", evidence_keys: ["ev-b"] },
        { run_revision: 1, question_id: "d", status: "answered", confidence: "high", short_answer: "gone", evidence_keys: ["ev-d"] },
      ] });
    const response = await GET(new NextRequest("http://localhost/api/site-analysis/41/compare"), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(200);
    expect(mocks.query.mock.calls[0]).toEqual([expect.stringContaining("project_id = $2"), [41, 31]]);
    expect(await response.json()).toMatchObject({ comparison: {
      currentRevision: 2,
      previousRevision: 1,
      new: ["c"],
      changed: ["a"],
      disappeared: ["d"],
      unchanged: 1,
    } });
  });

  it("returns an empty comparison for the first run", async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ run_revision: 1, request_id: "req-41" }] })
      .mockResolvedValueOnce({ rows: [{ run_revision: 1, question_id: "a", status: "answered", confidence: "high", short_answer: "one", evidence_keys: [] }] });
    const response = await GET(new NextRequest("http://localhost/api/site-analysis/41/compare"), { params: Promise.resolve({ id: "41" }) });
    expect(await response.json()).toMatchObject({ comparison: { previousRevision: null } });
  });
});
