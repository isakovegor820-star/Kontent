import { afterEach, describe, expect, it, vi } from "vitest";

import nextConfig from "../../next.config";

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

  it("enforces a production CSP without opening arbitrary script or connection origins", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const rules = await nextConfig.headers?.();
    const headers = new Map((rules?.[0]?.headers ?? []).map((header) => [header.key, header.value]));
    const csp = headers.get("Content-Security-Policy") ?? "";

    expect(nextConfig.poweredByHeader).toBe(false);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://telegram.org");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("connect-src *");
  });
});
