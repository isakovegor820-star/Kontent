import { describe, expect, it } from "vitest";
import {
  appThemeColor,
  normalizeAppThemePreference,
  resolveAppTheme,
} from "./app-theme";

describe("app theme preference", () => {
  it("keeps every supported preference and defaults unknown values to dark", () => {
    expect(normalizeAppThemePreference("light")).toBe("light");
    expect(normalizeAppThemePreference("dark")).toBe("dark");
    expect(normalizeAppThemePreference("system")).toBe("system");
    expect(normalizeAppThemePreference("sepia")).toBe("dark");
    expect(normalizeAppThemePreference(undefined)).toBe("dark");
  });

  it("resolves the system preference without changing explicit choices", () => {
    expect(resolveAppTheme("light", true)).toBe("light");
    expect(resolveAppTheme("dark", false)).toBe("dark");
    expect(resolveAppTheme("system", true)).toBe("dark");
    expect(resolveAppTheme("system", false)).toBe("light");
  });

  it("uses browser chrome colors that match the resolved surface", () => {
    expect(appThemeColor("dark")).toBe("#070a10");
    expect(appThemeColor("light")).toBe("#ffffff");
  });
});
