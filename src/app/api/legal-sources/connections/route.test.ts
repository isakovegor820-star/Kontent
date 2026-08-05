import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  connectLegalSource: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/legal-source-service", () => ({ connectLegalSource: mocks.connectLegalSource }));

import { POST } from "./route";

const key = "legal-connect:12345678";

function request(body: Record<string, unknown>, origin = "http://localhost") {
  return new NextRequest("http://localhost/api/legal-sources/connections", {
    method: "POST",
    headers: { origin, "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({ requestKey: key, ...body }),
  });
}

describe("POST /api/legal-sources/connections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.connectLegalSource.mockResolvedValue({
      status: 503,
      body: { ok: false, error: "not_configured", retryable: false },
    });
  });

  it("truthfully fails when no licensed official endpoint is configured", async () => {
    const response = await POST(request({ providerId: "vendor-law", token: "official-token" }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "not_configured",
      requestId: expect.any(String),
    });
    expect(mocks.connectLegalSource).toHaveBeenCalledWith({}, {
      userId: 7,
      requestKey: key,
      providerId: "vendor-law",
      token: "official-token",
    });
  });

  it.each([
    { password: "subscriber-password" },
    { cookies: "session=secret" },
    { auth: { sessionId: "browser-session" } },
  ])("rejects prohibited subscriber credentials before the service call", async (forbidden) => {
    const response = await POST(request({ providerId: "vendor-law", token: "official-token", ...forbidden }));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden_credential_field" });
    expect(mocks.connectLegalSource).not.toHaveBeenCalled();
  });

  it("rejects cross-site requests before auth and provider access", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValue(false);
    const response = await POST(request({ providerId: "vendor-law", token: "official-token" }, "https://attacker.example"));
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.connectLegalSource).not.toHaveBeenCalled();
  });
});
