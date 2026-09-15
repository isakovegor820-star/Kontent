import { ProjectRequest } from "@/test/project-request";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  session: vi.fn(),
  resolveChannel: vi.fn(),
  queueAdd: vi.fn(),
  trusted: vi.fn(),
}));

vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: vi.fn(async () => ({ projectId: 1, userId: 7, role: "owner", version: 1 })) };
});
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/autopilot", () => ({ resolveChannel: mocks.resolveChannel }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.queueAdd }) }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.trusted }));

import { GET, PATCH, POST } from "./route";

function request(body: unknown) {
  return new ProjectRequest(1, "http://localhost/api/competitors/suggestions", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function routeRequest(method: "GET" | "POST") {
  return new ProjectRequest(1, "http://localhost/api/competitors/suggestions?channel=11", {
    method,
  });
}

describe("thematic competitor discovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.trusted.mockReturnValue(true);
    mocks.session.mockResolvedValue({ id: 7 });
    mocks.resolveChannel.mockResolvedValue(11);
    mocks.queueAdd.mockResolvedValue({});
  });

  it("returns only suggestions confirmed against the saved channel topic", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select niche, ready")) {
        return { rowCount: 1, rows: [{ niche: "Вайб-кодинг", ready: true }] };
      }
      if (sql.includes("from competitor_suggestions")) return { rowCount: 0, rows: [] };
      if (sql.includes("select (")) return { rowCount: 1, rows: [{ n: 1 }] };
      return { rowCount: 0, rows: [] };
    });

    const response = await GET(routeRequest("GET"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ topic: "Вайб-кодинг", suggestions: [] });
    const suggestionsSql = mocks.query.mock.calls.find(([sql]) => String(sql).includes("from competitor_suggestions"));
    expect(String(suggestionsSql?.[0])).toContain("s.on_topic = true");
    expect(String(suggestionsSql?.[0])).not.toContain("is distinct from false");
  });

  it("does not launch broad discovery before the topic is confirmed", async () => {
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{ niche: "Вайб-кодинг", ready: false }] });

    const response = await POST(routeRequest("POST"));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "topic_required" });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
  });

  it("launches an idempotent topic-scoped discovery job", async () => {
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{ niche: "Вайб-кодинг", ready: true }] });

    const response = await POST(routeRequest("POST"));

    expect(response.status).toBe(200);
    expect(mocks.queueAdd).toHaveBeenCalledWith(
      "discover",
      { userId: 7, channelId: 11 },
      expect.objectContaining({ jobId: expect.stringMatching(/^discover-topic-7-11-/u) }),
    );
  });
});

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
