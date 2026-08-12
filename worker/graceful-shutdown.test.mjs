import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("worker graceful shutdown", () => {
  it("starts queue cleanup only once when a process-group signal is forwarded twice", () => {
    const source = readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");
    const shutdown = source.slice(
      source.indexOf("let shutdownStarted = false;"),
      source.indexOf('process.on("SIGTERM"'),
    );

    expect(shutdown).toContain("if (shutdownStarted) return;");
    expect(shutdown).toContain("shutdownStarted = true;");
    expect(shutdown.indexOf("if (shutdownStarted) return;")).toBeLessThan(
      shutdown.indexOf("await worker?.close();"),
    );
  });
});
