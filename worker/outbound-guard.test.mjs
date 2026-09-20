import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { assertWorkerOutboundAllowed } from "./outbound-guard.mjs";
import { assertRestoredDatabaseTarget } from "../scripts/prepare-restored-publications.mjs";

describe("restore publication hold", () => {
  it("blocks worker consumers before any missing credentials or connection can be used", () => {
    const result = spawnSync(process.execPath, ["worker.mjs"], { cwd: new URL("..", import.meta.url), env: { PATH: process.env.PATH, AURORA_OUTBOUND_DISABLED: "1", AURORA_SENTRY_DISABLED: "1" }, encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("worker_outbound_disabled");
    expect(result.stderr).not.toContain("DATABASE_URL");
    expect(result.stdout).not.toContain("очередь");
  });
  it("allows ordinary explicitly configured runtimes and limits restore apply to disposable databases", () => {
    expect(() => assertWorkerOutboundAllowed({})).not.toThrow();
    expect(() => assertRestoredDatabaseTarget("postgres://localhost/aurora_s02_restore_test", true)).not.toThrow();
    expect(() => assertRestoredDatabaseTarget("postgres://localhost/production", true)).toThrow("disposable");
    expect(() => assertRestoredDatabaseTarget("postgres://remote.invalid/aurora_s02_restore_test", true)).toThrow("disposable");
  });
});
