import { describe, expect, it } from "vitest";

import {
  buildTrackedDestination,
  classifyLikelyBot,
  conversionIdempotencyHash,
  createShortLinkSlug,
  normalizeTrackingDestination,
  normalizeUtmValues,
  signAttribution,
  verifyAttribution,
  visitorFingerprint,
} from "./tracked-links";

const SECRET = "test-secret-that-is-longer-than-thirty-two-bytes";

describe("tracked links", () => {
  it("normalizes UTM fields without losing existing query or fragment", () => {
    expect(buildTrackedDestination("https://example.ru/path?ref=old#form", {
      utm_source: " Telegram ",
      utm_campaign: "Банкротство   бизнеса",
    })).toBe(
      "https://example.ru/path?ref=old&utm_source=Telegram&utm_campaign=%D0%91%D0%B0%D0%BD%D0%BA%D1%80%D0%BE%D1%82%D1%81%D1%82%D0%B2%D0%BE+%D0%B1%D0%B8%D0%B7%D0%BD%D0%B5%D1%81%D0%B0#form",
    );
    expect(normalizeUtmValues({ utm_medium: "  social  media " })).toEqual({ utm_medium: "social media" });
  });

  it("rejects unsafe destinations and personal data in UTM", () => {
    for (const unsafe of [
      "javascript:alert(1)",
      "https://user:pass@example.ru",
      "http://localhost/form",
      "http://127.0.0.1/form",
      "http://10.0.0.3/form",
      "http://[::1]/form",
    ]) expect(() => normalizeTrackingDestination(unsafe)).toThrow();
    expect(() => normalizeUtmValues({ utm_content: "egor@example.ru" })).toThrow(
      "utm_content_contains_personal_data",
    );
    expect(() => normalizeUtmValues({ utm_term: "+7 999 123-45-67" })).toThrow(
      "utm_term_contains_personal_data",
    );
  });

  it("creates unpredictable URL-safe slugs", () => {
    const slugs = new Set(Array.from({ length: 100 }, createShortLinkSlug));
    expect(slugs.size).toBe(100);
    for (const slug of slugs) expect(slug).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  });

  it("signs attribution with TTL and rejects tampering, expiry and future issuance", () => {
    const token = signAttribution({ shortLinkId: 42, clickId: "click_123456" }, SECRET, {
      now: 1_800_000_000,
      ttlSeconds: 3_600,
    });
    expect(verifyAttribution(token, SECRET, { now: 1_800_000_100 })).toMatchObject({
      shortLinkId: 42,
      clickId: "click_123456",
      expiresAt: 1_800_003_600,
    });
    expect(verifyAttribution(`${token.slice(0, -1)}x`, SECRET, { now: 1_800_000_100 })).toBeNull();
    expect(verifyAttribution(token, SECRET, { now: 1_800_003_601 })).toBeNull();
  });

  it("minimizes visitor data and applies documented bot/idempotency rules", () => {
    const fingerprint = visitorFingerprint({ ip: "203.0.113.42", userAgent: "Mozilla/5.0" }, SECRET);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprint).not.toContain("203.0.113.42");
    expect(classifyLikelyBot("TelegramBot (like TwitterBot)")).toBe(true);
    expect(classifyLikelyBot("Mozilla/5.0 Safari/605.1.15")).toBe(false);
    expect(conversionIdempotencyHash(7, "event:form_submit:123")).toBe(
      conversionIdempotencyHash(7, "event:form_submit:123"),
    );
    expect(conversionIdempotencyHash(8, "event:form_submit:123")).not.toBe(
      conversionIdempotencyHash(7, "event:form_submit:123"),
    );
  });
});
