import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  getSessionUser: vi.fn(),
  probePublication: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/readiness-probes", () => ({
  probeRedisAndPublicationWorker: mocks.probePublication,
}));

import { POST } from "./route";

function request() {
  return new NextRequest("http://localhost/api/publication-operations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      draftId: 41,
      draftVersion: 3,
      timezone: "Europe/Amsterdam",
    }),
  });
}

describe("POST /api/publication-operations readiness gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
  });

  it.each([
    { redis: "up", publicationWorker: "down" },
    { redis: "down", publicationWorker: "down" },
    { redis: "not_configured", publicationWorker: "not_configured" },
  ])("keeps the draft untouched when publication is unavailable: %o", async (readiness) => {
    mocks.probePublication.mockResolvedValue(readiness);

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      result: "worker_unavailable",
      error: "publication_worker_unavailable",
      retryable: true,
    });
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it("rolls back and reports operation_not_created when PostgreSQL fails before commit", async () => {
    mocks.probePublication.mockResolvedValue({ redis: "up", publicationWorker: "up" });
    const databaseError = Object.assign(new Error("snapshot unavailable"), { code: "XX000" });
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // begin
        .mockRejectedValueOnce(databaseError) // replay lookup
        .mockResolvedValueOnce({ rows: [] }), // rollback
      release: vi.fn(),
    };
    mocks.getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client) });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      result: "operation_not_created",
      error: "operation_not_created",
    });
    expect(client.query).toHaveBeenLastCalledWith("rollback");
    expect(client.release).toHaveBeenCalledOnce();
    errorLog.mockRestore();
  });
});
