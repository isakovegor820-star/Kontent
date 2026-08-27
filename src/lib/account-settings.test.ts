import { describe, expect, it } from "vitest";

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  isCompleteNotificationPreferences,
  normalizeAccountProfile,
  normalizeNotificationPreferences,
  normalizePhone,
  normalizeTimezone,
  parseAccountProfileUpdate,
} from "./account-settings";

describe("account settings", () => {
  it("normalizes Russian and international phone input", () => {
    expect(normalizePhone("8 (927) 123-45-67")).toBe("+79271234567");
    expect(normalizePhone("+1 415 555 0123")).toBe("+14155550123");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("")).toBe("");
  });

  it("accepts only real IANA timezones", () => {
    expect(normalizeTimezone("Europe/Saratov")).toBe("Europe/Saratov");
    expect(normalizeTimezone("Moon/Sea_of_Tranquility")).toBeNull();
  });

  it("keeps profile fields bounded and requires explicit selectors on writes", () => {
    const normalized = normalizeAccountProfile({
      displayName: "  Аврора   Автор  ",
      firstName: "А".repeat(200),
      locale: "unknown",
      theme: "unknown",
    });
    expect(normalized.displayName).toBe("Аврора Автор");
    expect(normalized.firstName).toHaveLength(80);
    expect(normalized.locale).toBe("ru");
    expect(normalized.theme).toBe("system");

    expect(parseAccountProfileUpdate({ displayName: "Егор" })).toEqual({ ok: false, error: "bad_locale" });
    expect(parseAccountProfileUpdate({
      displayName: "Егор",
      locale: "ru",
      theme: "system",
      timezone: "Europe/Saratov",
    })).toMatchObject({ ok: true, value: { displayName: "Егор", theme: "system" } });
  });

  it("normalizes a partial notification matrix without losing secure defaults", () => {
    const result = normalizeNotificationPreferences({
      publication_ready: { email: false },
      security: { telegram: true },
    });
    expect(result.publication_ready.email).toBe(false);
    expect(result.publication_ready.inApp).toBe(true);
    expect(result.security.telegram).toBe(true);
    expect(result.autopilot_plan).toEqual(DEFAULT_NOTIFICATION_PREFERENCES.autopilot_plan);
    expect(isCompleteNotificationPreferences(result)).toBe(true);
    expect(isCompleteNotificationPreferences({ publication_ready: {} })).toBe(false);
  });
});
