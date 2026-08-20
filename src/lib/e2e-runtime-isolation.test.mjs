import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("real E2E runtime isolation", () => {
  it("uses a fresh Next dist directory for every intentional runtime restart", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).not.toContain('AURORA_NEXT_DIST_DIR: ".next-e2e-real"');
    expect(source).toContain("AURORA_NEXT_DIST_DIR: `.next-e2e-real-${distSuffix}`");
    expect(source).toContain("const distSuffix = label.toLowerCase()");
  });
});
