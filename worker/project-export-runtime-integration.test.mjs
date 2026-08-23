import fs from "node:fs";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");

describe("project export worker runtime wiring", () => {
  it("runs only in full worker mode and closes every export resource", () => {
    expect(source).toContain("createProjectExportWorker({ connection, pool, concurrency: 1 })");
    expect(source).toContain("new Queue(PROJECT_EXPORT_QUEUE, { connection })");
    expect(source).toContain("await projectExportWorker?.close()");
    expect(source).toContain("await projectExportQueue?.close()");
  });

  it("reconciles durable ownership at startup and every minute", () => {
    expect(source).toContain("reconcileProjectExportOutbox({");
    expect(source).toContain("expireProjectExportArtifacts(pool, 500)");
    expect(source).toContain('{ name: "exports",  pattern: "* * * * *" }');
    expect(source).toContain('["stats", "recon", "trend", "today-opportunities", "discover", "exports"]');
  });
});
