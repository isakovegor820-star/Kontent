import { describe, expect, it, vi } from "vitest";

import {
  acquireStableSiteAnalysisKey,
  bindStableSiteAnalysisKey,
  releaseStableSiteAnalysisKey,
  siteAnalysisIntentFingerprint,
} from "./site-analysis-client-key";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe("site analysis client idempotency key", () => {
  it("never persists credentials or sensitive query values in the intent fingerprint", () => {
    const fingerprint = siteAnalysisIntentFingerprint(
      "https://user:password@example.com/?access_token=secret&keep=1#fragment",
      "Example.COM",
    );
    expect(fingerprint).toContain("https://example.com/?keep=1");
    expect(fingerprint).not.toMatch(/password|secret|fragment/u);
  });

  it("reuses one key for the same intent across a lost response and reload", () => {
    const storage = memoryStorage();
    const uuid = vi.fn().mockReturnValueOnce("11111111-1111-4111-8111-111111111111");
    const first = acquireStableSiteAnalysisKey(storage, "create", "https://example.com/", "site-analysis", uuid);
    const replay = acquireStableSiteAnalysisKey(storage, "create", "https://example.com/", "site-analysis", uuid);
    expect(replay).toEqual(first);
    expect(uuid).toHaveBeenCalledOnce();
  });

  it("rotates on a new intent and releases only the bound terminal analysis", () => {
    const storage = memoryStorage();
    const first = acquireStableSiteAnalysisKey(storage, "create", "one", "site-analysis", () => "11111111-1111-4111-8111-111111111111");
    const bound = bindStableSiteAnalysisKey(storage, "create", first, 41);
    releaseStableSiteAnalysisKey(storage, "create", 42);
    expect(acquireStableSiteAnalysisKey(storage, "create", "one", "site-analysis", () => "unused")).toEqual(bound);
    releaseStableSiteAnalysisKey(storage, "create", 41);
    const next = acquireStableSiteAnalysisKey(storage, "create", "two", "site-analysis", () => "22222222-2222-4222-8222-222222222222");
    expect(next.key).toContain("22222222");
  });
});
