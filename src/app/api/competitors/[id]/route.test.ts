import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  session: vi.fn(),
  queueAdd: vi.fn(),
  trusted: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.queueAdd }) }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.trusted }));

import { PATCH } from "./route";

const ctx = { params: Promise.resolve({ id: "41" }) };
function request(action: string) {
  return new NextRequest("http://localhost/api/competitors/41", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });
}

describe("competitor source lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trusted.mockReturnValue(true);
    mocks.session.mockResolvedValue({ id: 7 });
    mocks.queueAdd.mockResolvedValue({});
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select id, is_active")) return { rowCount: 1, rows: [{ id: 41, is_active: true }] };
      return { rowCount: 1, rows: [] };
    });
  });

  it("pauses without enqueueing another collection", async () => {
    const response = await PATCH(request("pause"), ctx);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "paused", isActive: false });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("is_active = false"), [41, 7]);
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("resumes and manually refreshes through the same queue", async () => {
    const response = await PATCH(request("resume"), ctx);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "refreshing", isActive: true });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("status = 'refreshing'"), [41, 7]);
    expect(mocks.queueAdd).toHaveBeenCalledWith("competitor", { id: 41 }, expect.any(Object));
  });

  it("rejects unsupported lifecycle actions", async () => {
    const response = await PATCH(request("disconnect_forever"), ctx);
    expect(response.status).toBe(422);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
