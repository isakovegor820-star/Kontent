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
      error: "publication_worker_unavailable",
      retryable: true,
    });
    expect(mocks.getPool).not.toHaveBeenCalled();
  });
});
