import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("channel infopovody surface", () => {
  it("reuses the channel-scoped opportunity engine in market-only mode", () => {
    expect(source).toContain('import OpportunitiesPage from "../opportunities/page"');
    expect(source).toContain("<OpportunitiesPage />");
    expect(source).not.toContain("legal");
  });
});
