import { describe, expect, it } from "vitest";
import { createLoginRateLimitFixtureIngress, LOGIN_RATE_LIMIT_FIXTURE_HEADER } from "./e2e-login-rate-limit-coverage.mjs";

describe("isolated login limiter ingress", () => {
  it("requires the active random fixture and never accepts a caller-supplied IP claim", () => {
    const ingress = createLoginRateLimitFixtureIngress();
    const token = "a".repeat(48);
    const headers = { [LOGIN_RATE_LIMIT_FIXTURE_HEADER]: token, "x-forwarded-for": "203.0.113.19" };
    expect(ingress.resolve(headers)).toBeNull();
    ingress.register(token, "192.0.2.91");
    expect(ingress.resolve(headers)).toBe("192.0.2.91");
    expect(ingress.resolve({ [LOGIN_RATE_LIMIT_FIXTURE_HEADER]: [token] })).toBeNull();
    expect(ingress.resolve({ [LOGIN_RATE_LIMIT_FIXTURE_HEADER]: "b".repeat(48) })).toBeNull();
    ingress.release(token);
    expect(ingress.resolve(headers)).toBeNull();
  });
  it("does not reserve real/main addresses or overlapping active fixture identities", () => {
    const ingress = createLoginRateLimitFixtureIngress();
    const token = "a".repeat(48);
    for (const ip of ["127.0.0.1", "192.0.2.0", "192.0.2.255", "8.8.8.8"]) expect(() => ingress.register(token, ip)).toThrow();
    ingress.register(token, "192.0.2.1");
    expect(() => ingress.register(token, "192.0.2.2")).toThrow();
    expect(() => ingress.register("b".repeat(48), "192.0.2.1")).toThrow();
  });
});
