import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("CI dependency security gate", () => {
  it("fails CI on high-severity production dependency advisories", () => {
    expect(workflow).toContain("Audit production dependencies");
    expect(workflow).toContain("npm audit --omit=dev --audit-level=high");
  });
});
