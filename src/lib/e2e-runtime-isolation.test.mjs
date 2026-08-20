import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("real E2E runtime isolation", () => {
  it("clears only the test-owned Next dist directory for every intentional runtime restart", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain('AURORA_NEXT_DIST_DIR: ".next-e2e-real"');
    expect(source).toContain(
      "rmSync(resolve(runtimeEnv.AURORA_NEXT_DIST_DIR), { recursive: true, force: true })",
    );
    expect(source).not.toContain(".next-e2e-real-${distSuffix}");
  });

  it("accepts the visible save summary when a resolved error collapses its details", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain('const summary = await protection.locator("summary").textContent()');
    expect(source).toContain('summary?.includes("Сохранено") === true');
    expect(source).toContain('select text from drafts where id = $1 and project_id = $2');
  });
});
