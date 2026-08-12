import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRedirectTarget: vi.fn(),
  recordTrackedClick: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/rate-limit", () => ({
  clientIp: () => "203.0.113.10",
  checkRateLimit: vi.fn(async () => ({ allowed: true, limit: 300, remaining: 299, retryAfter: 0 })),
}));
vi.mock("@/lib/tracking-secrets", () => ({
  getTrackingSecrets: () => ({ attributionSecret: "a".repeat(40), fingerprintSecret: "b".repeat(40) }),
}));
vi.mock("@/lib/tracking-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tracking-service")>();
  return { ...actual, getRedirectTarget: mocks.getRedirectTarget, recordTrackedClick: mocks.recordTrackedClick };
});

import { GET } from "./route";

describe("GET /r/:slug", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRedirectTarget.mockResolvedValue({
      linkId: 41,
      projectId: 7,
      destinationUrl: "https://law.example.ru/form?utm_source=telegram",
      attributionWindowDays: 30,
    });
    mocks.recordTrackedClick.mockResolvedValue({ token: "signed-token", likelyBot: false });
  });

  it("redirects only to the stored destination and ignores query overrides", async () => {
    const response = await GET(
      new NextRequest("http://localhost/r/abcdefghijklmnopqrstuv?url=https://evil.example/"),
      { params: Promise.resolve({ slug: "abcdefghijklmnopqrstuv" }) },
    );
    const location = new URL(response.headers.get("location") ?? "");
    expect(response.status).toBe(307);
    expect(location.origin).toBe("https://law.example.ru");
    expect(location.pathname).toBe("/form");
    expect(location.searchParams.get("utm_source")).toBe("telegram");
    expect(location.searchParams.get("aurora_attribution")).toBe("signed-token");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("keeps the redirect available when click accounting is degraded", async () => {
    mocks.recordTrackedClick.mockRejectedValueOnce(new Error("database unavailable"));
    const response = await GET(
      new NextRequest("http://localhost/r/abcdefghijklmnopqrstuv"),
      { params: Promise.resolve({ slug: "abcdefghijklmnopqrstuv" }) },
    );
    const location = new URL(response.headers.get("location") ?? "");
    expect(response.status).toBe(307);
    expect(location.origin).toBe("https://law.example.ru");
    expect(location.searchParams.has("aurora_attribution")).toBe(false);
  });
});
