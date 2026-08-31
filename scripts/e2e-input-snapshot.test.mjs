import { describe, expect, it } from "vitest";

import { changedE2eInputPaths } from "./e2e-input-snapshot.mjs";

describe("real E2E input snapshot", () => {
  it("reports added, changed and removed files in stable order", () => {
    const baseline = { files: [
      { path: "src/a.ts", sha256: "a" },
      { path: "src/b.ts", sha256: "b" },
    ] };
    const current = { files: [
      { path: "src/a.ts", sha256: "changed" },
      { path: "src/c.ts", sha256: "c" },
    ] };

    expect(changedE2eInputPaths(baseline, current)).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
    ]);
  });
});
