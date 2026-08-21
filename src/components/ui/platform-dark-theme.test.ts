import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  path.join(process.cwd(), "src/app/app/app-v3.css"),
  "utf8",
);
const layout = readFileSync(
  path.join(process.cwd(), "src/app/app/layout.tsx"),
  "utf8",
);
const toaster = readFileSync(
  path.join(process.cwd(), "src/components/ui/toaster.tsx"),
  "utf8",
);

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`));
  if (!match) throw new Error(`Missing hex token --${name}`);
  return match[1];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("platform dark theme", () => {
  it("scopes a dark color scheme to the platform and portal UI", () => {
    expect(css).toContain("html:has(.app-v3)");
    expect(css).toContain("color-scheme: dark;");
    expect(css).toContain("body:has(.app-v3)");
    expect(css).toContain("[role=\"dialog\"]");
    expect(css).toContain(".v3-toast");
    expect(layout).toContain('colorScheme: "dark"');
    expect(layout).toContain('themeColor: "#070a10"');
    expect(toaster).toContain('pathname.startsWith("/app") || pathname.startsWith("/admin")');
    expect(toaster).not.toContain('pathname.startsWith("/register")');
  });

  it("uses genuinely dark layered surfaces instead of inverted white panels", () => {
    expect(token("bg")).toBe("#070a10");
    expect(token("bg-section")).toBe("#0b1018");
    expect(token("surface")).toBe("#111824");
    expect(token("surface-2")).toBe("#151e2c");
    expect(token("surface-inset")).toBe("#1b2636");
    expect(css).not.toContain("background: rgb(255 255 255 / 0.88)");
    expect(css).not.toContain("background-color: rgb(255 255 255 / 0.9)");
    expect(css).toContain(".app-v3 .text-brand");
    expect(css).not.toContain(".app-v3 .bg-brand {");
  });

  it("keeps body, secondary, status and primary-action text above WCAG AA", () => {
    const surface = token("surface");
    expect(contrast(token("text"), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("text-2"), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("text-3"), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#ffffff", token("brand-1"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("info-text"), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("brand-text-start"), token("bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("brand-text-end"), token("bg"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("success-text"), token("success-soft"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("danger-text"), token("danger-soft"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("fire-text"), token("fire-soft"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token("info-text"), token("info-soft"))).toBeGreaterThanOrEqual(4.5);
  });
});
