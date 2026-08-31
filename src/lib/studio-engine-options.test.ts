import { describe, expect, it } from "vitest";

import { readyStudioEngines } from "./studio-engine-options";

describe("Studio engine options", () => {
  it("keeps only models confirmed ready and preserves their order", () => {
    const engines = [
      { id: "ready-first", supported: true, status: "ready" as const },
      { id: "offline", supported: true, status: "offline" as const },
      { id: "not-connected", supported: true, status: "no_key" as const },
      { id: "roadmap", supported: false, status: "offline" as const },
      { id: "ready-second", supported: true, status: "ready" as const },
    ];

    expect(readyStudioEngines(engines).map((engine) => engine.id)).toEqual([
      "ready-first",
      "ready-second",
    ]);
  });
});
