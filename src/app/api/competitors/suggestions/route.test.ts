import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  session: vi.fn(),
  resolveChannel: vi.fn(),
  queueAdd: vi.fn(),
  trusted: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/autopilot", () => ({ resolveChannel: mocks.resolveChannel }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.queueAdd }) }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.trusted }));

import { PATCH } from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/competitors/suggestions", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/competitors/suggestions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trusted.mockReturnValue(true);
    mocks.session.mockResolvedValue({ id: 7 });
    mocks.resolveChannel.mockResolvedValue(11);
    mocks.queueAdd.mockResolvedValue({});
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select handle, channel_id")) {
        return { rowCount: 1, rows: [{ handle: "lawfirms", channel_id: 11 }] };
      }
      if (sql.includes("count(*)")) return { rowCount: 1, rows: [{ n: 1 }] };
      if (sql.includes("insert into competitors")) return { rowCount: 1, rows: [{ id: 88 }] };
      return { rowCount: 1, rows: [] };
    });
  });

  it("allows a project collaborator to accept a channel-owned suggestion", async () => {
    const response = await PATCH(request({ id: 51, action: "add" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, handle: "lawfirms" });
    expect(mocks.resolveChannel).toHaveBeenCalledWith(7, 11);
    const suggestionRead = mocks.query.mock.calls.find(([sql]) => String(sql).includes("select handle, channel_id"));
    expect(String(suggestionRead?.[0])).not.toContain("user_id");
    expect(suggestionRead?.[1]).toEqual([51]);
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("insert into competitors"));
    expect(insert?.[1]).toEqual([7, 11, "lawfirms"]);
    expect(mocks.queueAdd).toHaveBeenCalledWith("competitor", { id: 88 }, expect.any(Object));
  });

  it("does not accept a suggestion outside the selected project", async () => {
    mocks.resolveChannel.mockResolvedValue(null);

    const response = await PATCH(request({ id: 51, action: "add" }));

    expect(response.status).toBe(404);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("insert into competitors"))).toBe(false);
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });
});
