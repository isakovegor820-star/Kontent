import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("worker runtime syntax", () => {
  it("parses the production worker entrypoint", () => {
    const workerPath = fileURLToPath(new URL("../worker.mjs", import.meta.url));
    const result = spawnSync(process.execPath, ["--check", workerPath], { encoding: "utf8" });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
