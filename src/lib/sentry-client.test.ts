import { describe, expect, it } from "vitest";

import { buildConsent } from "@/lib/cookie-consent";
import { resolveSentryEnvironment, resolveTracesSampleRate, shouldStartClientSentry, startClientSentry } from "./sentry-client";

const analyticsConsent = buildConsent("all", { now: new Date(0) });
const necessaryOnly = buildConsent("necessary", { now: new Date(0) });

describe("client Sentry starts only with consent", () => {
  it("refuses to start when there is no decision yet", () => {
    expect(
      shouldStartClientSentry({ isProduction: true, disabled: false, enableInDevelopment: false, consent: null }),
    ).toBe(false);
  });

  it("refuses to start when only necessary cookies were allowed", () => {
    expect(
      shouldStartClientSentry({
        isProduction: true,
        disabled: false,
        enableInDevelopment: false,
        consent: necessaryOnly,
      }),
    ).toBe(false);
  });

  it("starts in production when analytics is allowed", () => {
    expect(
      shouldStartClientSentry({
        isProduction: true,
        disabled: false,
        enableInDevelopment: false,
        consent: analyticsConsent,
      }),
    ).toBe(true);
  });

  it("keeps development off unless it is explicitly enabled", () => {
    const base = { isProduction: false, disabled: false, consent: analyticsConsent };
    expect(shouldStartClientSentry({ ...base, enableInDevelopment: false })).toBe(false);
    expect(shouldStartClientSentry({ ...base, enableInDevelopment: true })).toBe(true);
  });

  it("honours the kill switch even with consent", () => {
    expect(
      shouldStartClientSentry({
        isProduction: true,
        disabled: true,
        enableInDevelopment: true,
        consent: analyticsConsent,
      }),
    ).toBe(false);
  });

  it("does not start on its own without consent", () => {
    // `Sentry.init` здесь не подменяется: экспорт ESM не конфигурируем.
    // Проверяем само решение — без согласия старта нет, и повторные вызовы
    // тоже ничего не запускают (идемпотентность нужна из-за события баннера).
    expect(startClientSentry("")).toBe(false);
    expect(startClientSentry("sid=abc")).toBe(false);
    expect(startClientSentry(`aurora_cookie_consent=${encodeURIComponent(JSON.stringify(necessaryOnly))}`)).toBe(false);
  });

  it("normalises trace sampling instead of passing garbage to the SDK", () => {
    expect(resolveTracesSampleRate({ isProduction: true, configured: "0.25" })).toBe(0.25);
    expect(resolveTracesSampleRate({ isProduction: true, configured: "2" })).toBe(0.1);
    expect(resolveTracesSampleRate({ isProduction: true, configured: "abc" })).toBe(0.1);
    // Пустая строка — «не задано», а не нулевая ставка.
    expect(resolveTracesSampleRate({ isProduction: true, configured: "" })).toBe(0.1);
    expect(resolveTracesSampleRate({ isProduction: false })).toBe(1);
    expect(resolveTracesSampleRate({ isProduction: false, configured: 0.5 })).toBe(0.5);
  });

  it("names the environment explicitly", () => {
    expect(resolveSentryEnvironment({ isProduction: true })).toBe("prod");
    expect(resolveSentryEnvironment({ isProduction: false })).toBe("development");
    expect(resolveSentryEnvironment({ isProduction: true, configuredEnvironment: "staging" })).toBe("staging");
  });
});
