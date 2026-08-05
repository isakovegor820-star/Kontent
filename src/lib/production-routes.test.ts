import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";

describe("production route isolation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("redirects the duplicate radar surface in every environment", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const redirects = await nextConfig.redirects!();
    expect(redirects).toContainEqual({
      source: "/app/radar",
      destination: "/app/recon",
      permanent: true,
    });
  });

  it("keeps design labs inaccessible in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const redirects = await nextConfig.redirects!();
    const sources = redirects.map((route) => route.source);
    expect(sources).toEqual(
      expect.arrayContaining([
        "/v2/:path*",
        "/v3/:path*",
        "/variants/:path*",
        "/old",
        "/scroll-test",
        "/finale/:path*",
        "/footer/:path*",
        "/reasons/:path*",
      ]),
    );
  });
});
