import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("app entry rollout", () => {
  it("enters the stable release through Calendar without an experimental probe", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(source).toContain('redirect("/app/calendar")');
    expect(source).not.toContain('fetch("/api/today"');
  });
});
