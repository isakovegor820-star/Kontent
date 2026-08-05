import { describe, it, expect } from "vitest";
import { clientIp, rateLimitResponse, unavailableRateLimitResult } from "./rate-limit";

function reqWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/x", { headers });
}

describe("clientIp", () => {
  it("берёт первый хоп из x-forwarded-for", () => {
    const ip = clientIp(reqWith({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 9.9.9.9" }));
    expect(ip).toBe("1.2.3.4");
  });

  it("одиночный x-forwarded-for", () => {
    expect(clientIp(reqWith({ "x-forwarded-for": "8.8.8.8" }))).toBe("8.8.8.8");
  });

  it("fallback на x-real-ip, когда нет x-forwarded-for", () => {
    expect(clientIp(reqWith({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("приоритет у x-forwarded-for перед x-real-ip", () => {
    const ip = clientIp(reqWith({ "x-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2" }));
    expect(ip).toBe("1.1.1.1");
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
