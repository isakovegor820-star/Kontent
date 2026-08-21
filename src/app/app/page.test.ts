import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("app entry rollout", () => {
  it("routes enabled Release 1 cohorts to Today and safely falls back to Calendar", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(source).toContain('fetch("/api/today"');
    expect(source).toContain('board?.enabled ? "/app/today" : "/app/calendar"');
    expect(source.match(/router\.replace\("\/app\/calendar"\)/gu)).toHaveLength(1);
  });
});
