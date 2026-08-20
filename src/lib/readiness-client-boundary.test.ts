import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("readiness client boundary", () => {
  it("does not probe operator-only readiness from the regular user settings UI", async () => {
    const settings = await readFile("src/app/app/settings/page.tsx", "utf8");
    expect(settings).not.toContain("/api/readiness");
    expect(settings).not.toContain("ServiceReadiness");
    expect(settings).not.toContain("Центр надёжности");
  });
});
