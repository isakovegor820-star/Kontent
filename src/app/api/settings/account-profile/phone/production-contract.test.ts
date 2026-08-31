import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  checkRateLimit: vi.fn(),
  getPool: vi.fn(),
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: vi.fn(),
}));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: () => true }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));

import { POST as confirmPhone } from "./confirm/route";
import { POST as requestPhone } from "./request/route";

function request(path: "request" | "confirm", body: Record<string, unknown>) {
  return new NextRequest(`https://aurora.example/api/settings/account-profile/phone/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("production phone verification contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AURORA_TEMPORARY_PHONE_VERIFICATION", "true");
    mocks.getSessionUser.mockResolvedValue({ id: 7, email: "owner@example.test" });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("does not create or expose a temporary code in production", async () => {
    const response = await requestPhone(request("request", { phone: "+79271234567" }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "phone_delivery_unavailable",
    });
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.getPool).not.toHaveBeenCalled();
  });

  it("does not confirm a temporary challenge left from another runtime", async () => {
    const response = await confirmPhone(request("confirm", { code: "123456" }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "phone_delivery_unavailable",
    });
    expect(mocks.getPool).not.toHaveBeenCalled();
  });
});
