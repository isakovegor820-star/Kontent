import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  acknowledgeAiUsageResult: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/ai-usage", () => ({ acknowledgeAiUsageResult: mocks.acknowledgeAiUsageResult }));

import { POST } from "./route";

function request(key = "studio_stream_test_1") {
  return new NextRequest("http://localhost/api/ai/generate/ack", {
    method: "POST",
    headers: { "idempotency-key": key },
  });
}

describe("POST /api/ai/generate/ack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.acknowledgeAiUsageResult.mockResolvedValue({
      changed: true,
      status: "committed",
      result: { protocol: "ndjson", text: "done" },
    });
  });

  it("commits only the authenticated user's staged stable request", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ai-acknowledged")).toBe("true");
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "committed", replayed: false });
    expect(mocks.acknowledgeAiUsageResult).toHaveBeenCalledWith(7, "web:studio_stream_test_1");
  });

  it("is idempotent when the terminal result was already committed", async () => {
    mocks.acknowledgeAiUsageResult.mockResolvedValue({
      changed: false,
      status: "committed",
      result: { protocol: "ndjson", text: "done" },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, replayed: true });
  });

  it("never commits without session, stable key, and a prepared terminal result", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(401);

    expect((await POST(request("bad"))).status).toBe(400);

    mocks.acknowledgeAiUsageResult.mockResolvedValue({ changed: false, status: "reserved", result: null });
    const pending = await POST(request());
    expect(pending.status).toBe(409);
    await expect(pending.json()).resolves.toMatchObject({ error: "terminal_not_prepared", retryable: true });
  });

  it("fails closed on cross-site mutation before touching session or quota", async () => {
    const response = await POST(new NextRequest("https://aurora.test/api/ai/generate/ack", {
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
        "idempotency-key": "studio_stream_test_1",
      },
    }));

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.acknowledgeAiUsageResult).not.toHaveBeenCalled();
  });
});
