import type { PoolClient } from "pg";
import { ProjectAccessError, roleAllows, type ActiveProjectMembership, type ProjectPermission, type ProjectRole } from "@/lib/project-permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  role: "owner" as ProjectRole,
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

// Route behavior is isolated here; real PostgreSQL authority/locks are covered by N21 integration.
vi.mock("@/lib/selected-project-transaction", () => ({
  withSelectedProjectPermission: async (pool: PoolClient, userId: number, permission: ProjectPermission,
    action: (client: PoolClient, membership: ActiveProjectMembership) => Promise<Response>) => {
    if (!roleAllows(mocks.role, permission)) throw new ProjectAccessError("permission_denied");
    return action(pool, { projectId: 13, userId, role: mocks.role, version: 1 });
  },
}));
vi.mock("@/lib/research-project-access", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/research-project-access")>(),
  researchChannel: mocks.resolveChannel,
}));

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
    mocks.role = "owner";
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
    expect(mocks.queueAdd).toHaveBeenCalledWith("competitor", { id: 81, userId: 7, projectId: 13 }, expect.any(Object));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("result.user_id = $2"), [41, 7, 13]);
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

  it("saves a public OSINT dossier as a reference instead of a competitor", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from radar_search_results")) return {
        rowCount: 1,
        rows: [{
          ...channelResult,
          result_type: "profile",
          handle: "plinoffcial",
          title: "Plin Official",
          text: "Био\nПубличный автор",
          url: "https://example.com/plinoffcial",
          query: "plinoffcial",
        }],
      };
      if (sql.includes("insert into saved_posts")) return { rowCount: 1, rows: [{ id: "56" }] };
      return { rowCount: 0, rows: [] };
    });
    const response = await POST(new NextRequest("http://localhost/api/radar/results/41", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "save_reference", channelId: 11 }),
    }), ctx);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, id: 56, saved: true });
    expect(mocks.queueAdd).not.toHaveBeenCalled();
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
