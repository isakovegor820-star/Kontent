import { afterEach, describe, it, expect, vi } from "vitest";
import { clientIp, rateLimitResponse, unavailableRateLimitResult } from "./rate-limit";

function reqWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/x", { headers });
}

describe("clientIp", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("берёт доверенный хоп справа, поэтому клиентский префикс не меняет IP", () => {
    const ip = clientIp(reqWith({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9" }));
    expect(ip).toBe("9.9.9.9");
  });

  it("одиночный x-forwarded-for", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": "8.8.8.8" }))).toBe("8.8.8.8");
  });

  it("не доверяет x-real-ip без явной ingress-настройки", () => {
    expect(clientIp(reqWith({ "x-real-ip": "9.9.9.9" }))).toBe("unknown");
    vi.stubEnv("AURORA_TRUST_X_REAL_IP", "true");
    expect(clientIp(reqWith({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("приоритет у правого x-forwarded-for перед x-real-ip", () => {
    vi.stubEnv("AURORA_TRUST_X_REAL_IP", "true");
    const ip = clientIp(reqWith({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }));
    expect(ip).toBe("1.1.1.1");
  });

  it("поддерживает заданное число доверенных proxy и отбрасывает мусор", () => {
    vi.stubEnv("AURORA_TRUSTED_PROXY_HOPS", "2");
    expect(clientIp(reqWith({
      "x-forwarded-for": "spoofed, 192.0.2.10, 198.51.100.20",
    }))).toBe("192.0.2.10");
  });

  it("нет заголовков — unknown", () => {
    expect(clientIp(reqWith({}))).toBe("unknown");
  });
});

describe("rate-limit outage policy", () => {
  it("fails closed with an explicit 503 for security-sensitive flows", async () => {
    const result = unavailableRateLimitResult(5, 3600, "closed");
    expect(result).toEqual({
      allowed: false,
      limit: 5,
      remaining: 0,
      retryAfter: 30,
      unavailable: true,
    });

    const response = rateLimitResponse(result);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "rate_limit_unavailable",
      retryAfter: 30,
    });
  });

  it("keeps the existing fail-open default for non-critical callers", () => {
    expect(unavailableRateLimitResult(10, 900)).toEqual({
      allowed: true,
      limit: 10,
      remaining: 10,
      retryAfter: 0,
    });
  });
});
