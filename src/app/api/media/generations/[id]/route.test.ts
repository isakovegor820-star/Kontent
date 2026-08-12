import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  reconcileStaleMediaGeneration: vi.fn(),
  poolQuery: vi.fn(),
  pool: { connect: vi.fn(), query: vi.fn() },
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/media-generation-reconciliation", () => ({
  reconcileStaleMediaGeneration: mocks.reconcileStaleMediaGeneration,
}));
vi.mock("@/lib/db", () => ({ getPool: () => mocks.pool }));
vi.mock("@/lib/project-permissions", () => ({
  ProjectAccessError: class ProjectAccessError extends Error {},
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));

import { GET } from "./route";

describe("GET /api/media/generations/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pool.query = mocks.poolQuery;
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 23,
      userId: 7,
      role: "author",
      version: 1,
    });
    mocks.reconcileStaleMediaGeneration.mockResolvedValue({ reconciled: [], released: [] });
    mocks.poolQuery.mockResolvedValue({
      rows: [{
        id: 41,
        request_id: "11111111-1111-4111-8111-111111111111",
        kind: "image",
        status: "generating",
        prompt: "brief",
        negative_prompt: null,
        source_text: "post",
        exact_text: "",
        model: "nano-banana-2",
        aspect_ratio: "1:1",
        quality: "medium",
        seconds: null,
        style: "editorial",
        output_asset_id: null,
        mime_type: null,
        bytes: null,
        error_code: null,
        error_message: null,
        created_at: new Date("2026-08-05T10:00:00.000Z"),
        updated_at: new Date("2026-08-05T10:00:05.000Z"),
        completed_at: null,
      }],
    });
  });

  it("reconciles a missing terminal event before selecting the generation", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/media/generations/41"),
      { params: Promise.resolve({ id: "41" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.reconcileStaleMediaGeneration).toHaveBeenCalledWith(
      mocks.pool,
      { userId: 7, projectId: 23, generationId: 41 },
    );
    expect(mocks.reconcileStaleMediaGeneration.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.poolQuery.mock.invocationCallOrder[0]);
    await expect(response.json()).resolves.toMatchObject({
      requestId: "11111111-1111-4111-8111-111111111111",
      generation: { id: "41", status: "generating" },
    });
    expect(mocks.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("where g.id = $1 and g.project_id = $2"),
      [41, 23],
    );
  });
});
