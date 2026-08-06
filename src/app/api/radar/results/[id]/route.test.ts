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

const ctx = { params: Promise.resolve({ id: "41" }) };
const channelResult = {
  id: "41",
  result_type: "channel",
  handle: "umsadovnik",
  title: "Умный садовник",
  description: "Садоводство",
  subscribers: 18300,
  text: null,
  url: "https://t.me/umsadovnik",
  reason: "Канал активен",
  query: "садоводство",
};

describe("radar result actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ id: 7 });
    mocks.resolveChannel.mockResolvedValue(11);
    mocks.trusted.mockReturnValue(true);
    mocks.queueAdd.mockResolvedValue({});
  });

  it("adds only a verified result owned by the current user", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from radar_search_results")) return { rowCount: 1, rows: [channelResult] };
      if (sql.includes("count(*)")) return { rowCount: 1, rows: [{ n: 2 }] };
      if (sql.includes("select id from competitors")) return { rowCount: 0, rows: [] };
      if (sql.includes("insert into competitors")) return { rowCount: 1, rows: [{ id: "81" }] };
      return { rowCount: 0, rows: [] };
    });
    const response = await POST(new NextRequest("http://localhost/api/radar/results/41", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "add_competitor", channelId: 11 }),
    }), ctx);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, id: 81, handle: "umsadovnik" });
    expect(mocks.queueAdd).toHaveBeenCalledWith("competitor", { id: 81 }, expect.any(Object));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("result.user_id = $2"), [41, 7]);
  });

  it("saves a verified post as a deduplicated library reference", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from radar_search_results")) return {
        rowCount: 1,
        rows: [{ ...channelResult, result_type: "post", text: "Как подготовить сад к зиме", url: "https://t.me/umsadovnik/10" }],
      };
      if (sql.includes("insert into saved_posts")) return { rowCount: 1, rows: [{ id: "55" }] };
      return { rowCount: 0, rows: [] };
    });
    const response = await POST(new NextRequest("http://localhost/api/radar/results/41", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_idea", channelId: 11 }),
    }), ctx);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, id: 55, saved: true });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("on conflict (user_id, channel_id, source_url)"), expect.any(Array));
  });

  it("returns not found instead of acting on another user's result", async () => {
    mocks.query.mockResolvedValue({ rowCount: 0, rows: [] });
    const response = await POST(new NextRequest("http://localhost/api/radar/results/41", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_idea", channelId: 11 }),
    }), ctx);
    expect(response.status).toBe(404);
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });
});
