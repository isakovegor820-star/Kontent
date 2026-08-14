import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getSessionUser: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { GET } from "./route";

describe("GET /api/site-analysis/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
  });

  it("scopes the result to its owner and returns the persisted request ID", async () => {
    const startedAt = new Date("2026-08-14T14:00:00.000Z");
    mocks.query.mockResolvedValue({ rows: [{
      id: "41", request_id: "req-41", target_url: "https://example.com/", confirmed_domain: "example.com",
      status: "ready", stage: "ready", progress: 100, progress_detail: "Готово", limits: {}, result: { inventory: [] },
      error_code: null, error_message: null, attempts: 1, run_revision: 1, queue_confirmed_at: startedAt,
      created_at: new Date(), updated_at: new Date(), completed_at: new Date(),
    }] });
    const response = await GET(new NextRequest("http://localhost/api/site-analysis/41"), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("req-41");
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("where id = $1 and user_id = $2"), [41, 7]);
    expect(await response.json()).toMatchObject({
      analysis: {
        startedAt: startedAt.toISOString(),
        serverNow: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        result: { inventory: [] },
      },
    });
  });

  it("does not reveal another user's analysis", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    const response = await GET(new NextRequest("http://localhost/api/site-analysis/41"), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(404);
  });
});
