import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  resolveChannel: vi.fn(),
  channelAiContextFor: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/autopilot", () => ({ resolveChannel: mocks.resolveChannel }));
vi.mock("@/lib/ai-usage", () => ({ channelAiContextFor: mocks.channelAiContextFor }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: vi.fn() }));

import { GET } from "./route";

const request = () => new NextRequest("http://localhost/api/knowledge?channel=22");

describe("GET /api/knowledge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 5 });
    mocks.resolveChannel.mockResolvedValue(22);
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 1, kind: "form", title: "Факты", status: "ready", chunks: 2 }] })
      .mockResolvedValueOnce({ rows: [{ facts: 2, voice: 1 }] });
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
