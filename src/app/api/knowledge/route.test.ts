import { ProjectRequest } from "@/test/project-request";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  channelAiContextFor: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/ai-usage", () => ({ channelAiContextFor: mocks.channelAiContextFor }));
vi.mock("@/lib/db", () => ({ getPool: () => ({
  query: mocks.query,
  connect: async () => ({ query: mocks.query, release: vi.fn() }),
}) }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: vi.fn() }));

import { GET } from "./route";

const request = () => new ProjectRequest(8, "http://localhost/api/knowledge?channel=22");

describe("GET /api/knowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
    mocks.query.mockImplementation(async (sql: string) => {
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [] };
      if (sql.includes("from project_members")) return { rows: [{ project_id: 8, user_id: 5, role: "author", version: 1 }] };
      if (sql.includes("from channels")) return { rows: [{ id: 22, project_id: 8 }], rowCount: 1 };
      if (sql.includes("from knowledge_sources")) return { rows: [{ id: 1, kind: "form", title: "Факты", status: "ready", chunks: 2 }] };
      if (sql.includes("from knowledge_chunks")) return { rows: [{ facts: 2, voice: 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    mocks.channelAiContextFor.mockResolvedValue({
      profileProvenance: {
        niche: {
          value: "Legal tech",
          sourceId: "content-brief",
          sourceKind: "verified_brief",
          verified: true,
        },
      },
    });
  });

  it("requires the account instead of returning a fake empty knowledge base", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "unauthorized" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns the field-level effective profile and its provenance", async () => {
    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      channelId: 22,
      facts: 2,
      voice: 1,
      effectiveProfile: {
        niche: {
          value: "Legal tech",
          sourceKind: "verified_brief",
          verified: true,
        },
      },
    });
    expect(mocks.channelAiContextFor).toHaveBeenCalledWith(5, 22, 10, expect.anything());
  });

  it("returns 503 rather than disguising a database failure as an empty profile", async () => {
    mocks.query.mockReset().mockRejectedValue(new Error("database offline"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET(request());
    errorLog.mockRestore();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "unavailable" });
  });
});
