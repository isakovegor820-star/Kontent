import { describe, expect, it } from "vitest";
import {
  appThemeColor,
  nextAppThemePreference,
  normalizeAppThemePreference,
  resolveAppTheme,
} from "./app-theme";

describe("app theme preference", () => {
  it("supports only explicit light and dark preferences", () => {
    expect(normalizeAppThemePreference("light")).toBe("light");
    expect(normalizeAppThemePreference("dark")).toBe("dark");
    expect(normalizeAppThemePreference("system")).toBe("dark");
    expect(normalizeAppThemePreference("sepia")).toBe("dark");
    expect(normalizeAppThemePreference(undefined)).toBe("dark");
  });

  it("resolves explicit choices without consulting the device theme", () => {
    expect(resolveAppTheme("light")).toBe("light");
    expect(resolveAppTheme("dark")).toBe("dark");
  });

  it("toggles directly between light and dark", () => {
    expect(nextAppThemePreference("dark")).toBe("light");
    expect(nextAppThemePreference("light")).toBe("dark");
  });

  it("uses browser chrome colors that match the resolved surface", () => {
    expect(appThemeColor("dark")).toBe("#070a10");
    expect(appThemeColor("light")).toBe("#ffffff");
  });
});
