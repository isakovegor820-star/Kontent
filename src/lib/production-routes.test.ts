import { afterEach, describe, expect, it, vi } from "vitest";

import nextConfig from "../../next.config";
import { buildContentSecurityPolicy } from "./content-security-policy";

afterEach(() => vi.unstubAllEnvs());

describe("production route surface", () => {
  it("redirects every internal design-lab family away from production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const redirects = await nextConfig.redirects?.();
    const sources = new Set((redirects ?? []).map((route) => route.source));

    for (const source of [
      "/v2/:path*",
      "/v3/:path*",
      "/variants/:path*",
      "/finale/:path*",
      "/footer/:path*",
      "/reasons/:path*",
      "/memory/:path*",
      "/quality/:path*",
      "/how/:path*",
      "/cycle/:path*",
    ]) {
      expect(sources.has(source), `${source} must not remain public`).toBe(true);
    }
  });

  it("keeps invariant hardening headers independent from the request nonce", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const rules = await nextConfig.headers?.();
    const headers = new Map((rules?.[0]?.headers ?? []).map((header) => [header.key, header.value]));

    expect(nextConfig.poweredByHeader).toBe(false);
    expect(headers.get("Content-Security-Policy")).toBeUndefined();
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("enforces a nonce-bound production CSP without arbitrary script or connection origins", () => {
    const csp = buildContentSecurityPolicy("YXVyb3JhLXByb2R1Y3Rpb24tbm9uY2U=");

    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/u);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/u);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("connect-src *");
  });
});
