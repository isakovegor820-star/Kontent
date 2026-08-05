import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
  aiReady: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/ai-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-provider")>();
  return { ...actual, aiReady: mocks.aiReady };
});

import { GET, POST } from "./route";

describe("/api/ai/engines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.query.mockResolvedValue({ rows: [{ ai_engine: "openai" }], rowCount: 1 });
    mocks.aiReady.mockResolvedValue(true);
  });

  it("correlates status responses and proposes one ready model without changing selection", async () => {
    const response = await GET(new NextRequest("http://localhost/api/ai/engines"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.requestId).toBe(response.headers.get("x-ai-request-id"));
    expect(body.current).toBe("openai");
    expect(body.suggestedEngine).toMatchObject({ id: "local", status: "ready" });
    expect(Array.isArray(body.suggestedEngine)).toBe(false);
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("correlates a forbidden-origin response before session or settings access", async () => {
    const response = await POST(new NextRequest("https://aurora.test/api/ai/engines", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ engine: "local" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({ error: "forbidden_origin", requestId: expect.any(String) });
    expect(body.requestId).toBe(response.headers.get("x-ai-request-id"));
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("requires a ready model before an explicit selection is persisted", async () => {
    mocks.aiReady.mockResolvedValue(false);
    const response = await POST(new NextRequest("http://localhost/api/ai/engines", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine: "local" }),
    }));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      ok: false,
      error: "engine_offline",
      engine: "local",
      requestId: response.headers.get("x-ai-request-id"),
    });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
