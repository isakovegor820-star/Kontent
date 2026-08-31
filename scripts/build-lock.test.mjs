import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { acquireBuildLock, buildLockDirectory } from "./build-lock.mjs";

describe("Aurora production build lock", () => {
  it("serializes builds for one checkout and releases only its own lock", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "aurora-build-lock-test-"));
    const options = {
      cwd: "/workspace/aurora",
      temporaryDirectory,
      pid: 4242,
      signalProcess() {},
      token: "11111111-1111-4111-8111-111111111111",
    };
    try {
      const releaseFirst = acquireBuildLock(options);
      const releaseReentrant = acquireBuildLock(options);
      expect(() => acquireBuildLock({
        ...options,
        token: "22222222-2222-4222-8222-222222222222",
      })).toThrowError(
        "another Aurora production build is running (pid 4242)",
      );
      releaseReentrant();
      releaseFirst();
      expect(() => acquireBuildLock(options)()).not.toThrow();
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("uses different lock paths for different checkouts", () => {
    expect(buildLockDirectory("/workspace/aurora", "/tmp"))
      .not.toBe(buildLockDirectory("/workspace/aurora-copy", "/tmp"));
  });
});
