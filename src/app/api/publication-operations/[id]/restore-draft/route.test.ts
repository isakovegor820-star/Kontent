import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(),
  getSessionUser: vi.fn(),
  authorizeOperation: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/app/api/publication-operations/_project-authorization", async (original) => ({
  ...await original<typeof import("@/app/api/publication-operations/_project-authorization")>(),
  authorizePublicationOperation: mocks.authorizeOperation,
}));
vi.mock("@/lib/publication-lifecycle.mjs", () => ({
  restorePublicationDraft: mocks.restore,
}));

import { POST } from "./route";
import { ProjectAccessError } from "@/lib/project-permissions";

const context = { params: Promise.resolve({ id: "7" }) };

function request(origin = "http://localhost") {
  return new NextRequest("http://localhost/api/publication-operations/7/restore-draft", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "restore-key",
      origin,
    },
    body: JSON.stringify({ expectedScheduleRevision: 2, expectedStatus: "cancelled" }),
  });
}

describe("POST /api/publication-operations/:id/restore-draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
    mocks.getPool.mockReturnValue({ query: vi.fn() });
    mocks.authorizeOperation.mockResolvedValue({ projectId: 23 });
    mocks.restore.mockResolvedValue({
      ok: true,
      operationId: 7,
      draftId: 51,
      draftVersion: 1,
      status: "cancelled",
      scheduleRevision: 2,
      replayed: false,
    });
  });

  it("checks trusted origin before session or database work", async () => {
    const response = await POST(request("https://evil.example"), context);

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.authorizeOperation).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("rejects a role without content.publish", async () => {
    mocks.authorizeOperation.mockRejectedValue(new ProjectAccessError("permission_denied"));

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden" });
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("restores only an operation owned in the selected project", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, draftId: 51 });
    expect(mocks.authorizeOperation).toHaveBeenCalledWith(expect.objectContaining({
      userId: 5,
      operationId: 7,
      permission: "content.publish",
      requireCreator: false,
    }));
    expect(mocks.restore).toHaveBeenCalledWith(expect.objectContaining({
      userId: 5,
      projectId: 23,
      operationId: 7,
      expectedRevision: 2,
      expectedStatus: "cancelled",
      idempotencyKey: "restore-key",
    }));
  });
});
