import { describe, expect, it } from "vitest";

import {
  COOKIE_CONSENT_MAX_AGE_SECONDS,
  COOKIE_CONSENT_NAME,
  buildConsent,
  consentCategories,
  consentCookieAttributes,
  hasAnalyticsConsent,
  parseConsent,
  readConsentFromCookieString,
  serializeConsent,
} from "./cookie-consent";

describe("cookie consent contract", () => {
  it("treats the absence of a cookie as no consent at all", () => {
    expect(parseConsent(null)).toBeNull();
    expect(parseConsent("")).toBeNull();
    expect(readConsentFromCookieString("")).toBeNull();
    expect(readConsentFromCookieString("sid=abc; aurora_app_theme=dark")).toBeNull();
    // До выбора аналитика запрещена — это читает инициализация Sentry.
    expect(hasAnalyticsConsent(null)).toBe(false);
  });

  it("never disables necessary cookies, whatever the decision", () => {
    for (const decision of ["all", "necessary", "custom"] as const) {
      expect(consentCategories(decision).necessary).toBe(true);
      expect(buildConsent(decision, { categories: { analytics: true }, now: new Date(0) }).categories.necessary).toBe(true);
    }
  });

  it("all means analytics and marketing, necessary means neither", () => {
    expect(consentCategories("all")).toEqual({ necessary: true, analytics: true, marketing: true });
    expect(consentCategories("necessary")).toEqual({ necessary: true, analytics: false, marketing: false });
  });

  it("keeps the decision time and the banner text version as evidence", () => {
    const consent = buildConsent("all", { now: new Date("2026-10-02T18:00:00.000Z"), version: "1.0" });
    expect(consent.decidedAt).toBe("2026-10-02T18:00:00.000Z");
    expect(consent.version).toBe("1.0");
  });

  it("round-trips through the cookie value", () => {
    const consent = buildConsent("custom", { categories: { analytics: true, marketing: false }, now: new Date(0) });
    const cookieString = `${COOKIE_CONSENT_NAME}=${serializeConsent(consent)}`;
    expect(readConsentFromCookieString(cookieString)).toEqual(consent);
    expect(hasAnalyticsConsent(readConsentFromCookieString(cookieString))).toBe(true);
  });

  it("does not trust a broken or foreign cookie value", () => {
    expect(parseConsent("not-json")).toBeNull();
    expect(parseConsent(encodeURIComponent(JSON.stringify({ decision: "all" })))).toBeNull();
    // Подделанное значение не может включить аналитику: necessary остаётся true,
    // а всё, что не совпало с форматом, читается как отсутствие выбора.
    expect(hasAnalyticsConsent(parseConsent("analytics=true"))).toBe(false);
  });

  it("writes a cookie that scripts can read and that expires", () => {
    const attributes = consentCookieAttributes(false);
    expect(attributes).toContain("Path=/");
    expect(attributes).toContain("SameSite=Lax");
    expect(attributes).toContain(`Max-Age=${COOKIE_CONSENT_MAX_AGE_SECONDS}`);
    // HttpOnly здесь был бы ошибкой: клиентская аналитика не увидела бы выбор.
    expect(attributes).not.toContain("HttpOnly");
    expect(consentCookieAttributes(true)).toContain("Secure");
  });
});
