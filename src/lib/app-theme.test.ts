import { describe, expect, it } from "vitest";
import {
  appThemeColor,
  nextAppThemePreference,
  normalizeAppThemePreference,
  resolveAppTheme,
} from "./app-theme";

describe("app theme preference", () => {
  it("supports light, dark and system preferences", () => {
    expect(normalizeAppThemePreference("light")).toBe("light");
    expect(normalizeAppThemePreference("dark")).toBe("dark");
    expect(normalizeAppThemePreference("system")).toBe("system");
    expect(normalizeAppThemePreference("sepia")).toBe("system");
    expect(normalizeAppThemePreference(undefined)).toBe("system");
  });

  it("resolves explicit choices without consulting the device theme", () => {
    expect(resolveAppTheme("light")).toBe("light");
    expect(resolveAppTheme("dark")).toBe("dark");
    expect(resolveAppTheme("system", false)).toBe("light");
    expect(resolveAppTheme("system", true)).toBe("dark");
  });

  it("cycles through light, dark and system", () => {
    expect(nextAppThemePreference("dark")).toBe("system");
    expect(nextAppThemePreference("light")).toBe("dark");
    expect(nextAppThemePreference("system")).toBe("light");
  });

  it("uses browser chrome colors that match the resolved surface", () => {
    expect(appThemeColor("dark")).toBe("#070a10");
    expect(appThemeColor("light")).toBe("#ffffff");
  });
});
