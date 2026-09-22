import { describe, expect, it } from "vitest";

import { LOCAL_REDIS_URL, resolveRedisUrl } from "./redis-url.mjs";

describe("redis url resolution", () => {
  it("returns an explicitly configured url untouched", () => {
    expect(resolveRedisUrl({ REDIS_URL: "redis://cache.internal:6379/3" })).toBe("redis://cache.internal:6379/3");
    // Явно заданный localhost легален: на одном сервере Redis живёт на 127.0.0.1.
    expect(resolveRedisUrl({ NODE_ENV: "production", REDIS_URL: LOCAL_REDIS_URL })).toBe(LOCAL_REDIS_URL);
  });

  it("keeps the localhost default outside production", () => {
    expect(resolveRedisUrl({ NODE_ENV: "development" })).toBe(LOCAL_REDIS_URL);
    expect(resolveRedisUrl({ NODE_ENV: "test" })).toBe(LOCAL_REDIS_URL);
    expect(resolveRedisUrl({})).toBe(LOCAL_REDIS_URL);
  });

  it("fails closed in production instead of silently listening to localhost (ревью P1)", () => {
    expect(() => resolveRedisUrl({ NODE_ENV: "production" })).toThrow("redis_url_not_configured");
    expect(() => resolveRedisUrl({ NODE_ENV: "production", REDIS_URL: "   " })).toThrow("redis_url_not_configured");
  });
});
