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

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/competitors/add", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/competitors/add", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trusted.mockReturnValue(true);
    mocks.session.mockResolvedValue({ id: 7 });
    mocks.resolveChannel.mockResolvedValue(11);
    mocks.queueAdd.mockResolvedValue({});
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("count(*)")) return { rowCount: 1, rows: [{ n: 1 }] };
      if (sql.includes("select id from competitors")) return { rowCount: 0, rows: [] };
      if (sql.includes("insert into competitors")) return { rowCount: 1, rows: [{ id: 88 }] };
      return { rowCount: 0, rows: [] };
    });
  });

  it("adds Instagram through the provider-neutral source contract", async () => {
    const response = await POST(request({
      network: "instagram",
      url: "https://instagram.com/NASA/",
      title: "NASA",
      channelId: 11,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, id: 88, handle: "nasa", network: "instagram" });
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("insert into competitors"));
    expect(insert?.[1]).toEqual([7, 11, "instagram", "nasa", "NASA", "instagram_business_discovery"]);
    expect(mocks.queueAdd).toHaveBeenCalledWith("competitor", { id: 88 }, expect.any(Object));
  });

  it("rejects content URLs and missing display names before touching the database", async () => {
    const badUrl = await POST(request({ network: "instagram", url: "instagram.com/p/ABC", title: "NASA" }));
    expect(badUrl.status).toBe(422);
    await expect(badUrl.json()).resolves.toMatchObject({ error: "bad" });

    const badTitle = await POST(request({ network: "tg", url: "t.me/durov", title: "" }));
    expect(badTitle.status).toBe(422);
    await expect(badTitle.json()).resolves.toMatchObject({ error: "bad_title" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("keeps the Telegram onboarding handle-only request compatible", async () => {
    const response = await POST(request({ handle: "durov" }));
    expect(response.status).toBe(200);
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).includes("insert into competitors"));
    expect(insert?.[1]).toEqual([7, 11, "tg", "durov", "@durov", "telegram_public_web"]);
  });
});
