import { describe, expect, it } from "vitest";

import {
  normalizeSiteAnalysisKey,
  serializeSiteAnalysis,
  siteAnalysisFingerprint,
} from "./site-analysis";

describe("site analysis API contract", () => {
  it("requires a stable bounded idempotency key", () => {
    expect(normalizeSiteAnalysisKey("short")).toBeNull();
    expect(normalizeSiteAnalysisKey("site-analysis:client-1234")).toBe("site-analysis:client-1234");
    expect(normalizeSiteAnalysisKey("contains spaces 1234")).toBeNull();
  });

  it("fingerprints normalized limits and target identity", () => {
    const first = siteAnalysisFingerprint({ targetUrl: "https://example.com/", confirmedDomain: "example.com", limits: { maxPages: 20 } });
    const same = siteAnalysisFingerprint({ targetUrl: "https://example.com/", confirmedDomain: "example.com", limits: { maxPages: 20.2 } });
    const changed = siteAnalysisFingerprint({ targetUrl: "https://example.com/other", confirmedDomain: "example.com", limits: { maxPages: 20 } });
    expect(first).toBe(same);
    expect(changed).not.toBe(first);
  });

  it("keeps objective progress and the correlation id in public rows", () => {
    expect(serializeSiteAnalysis({
      id: "41",
      request_id: "req-41",
      target_url: "https://example.com/",
      confirmed_domain: "example.com",
      status: "failed",
      stage: "failed",
      progress: "52",
      progress_detail: "Проверяем страницы",
      limits: {},
      result: null,
      error_code: "robots_denied",
      error_message: "robots.txt запрещает анализ",
      attempts: "1",
      run_revision: "2",
      queue_confirmed_at: null,
      created_at: "2026-08-05T00:00:00.000Z",
      updated_at: "2026-08-05T00:01:00.000Z",
      completed_at: "2026-08-05T00:01:00.000Z",
    }, true)).toMatchObject({
      id: 41,
      requestId: "req-41",
      progress: 52,
      error: { code: "robots_denied" },
      result: null,
    });
  });
});
