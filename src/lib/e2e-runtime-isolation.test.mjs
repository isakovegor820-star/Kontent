import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("real E2E runtime isolation", () => {
  it("builds once in an isolated directory and restarts the production entrypoint", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain('AURORA_NEXT_DIST_DIR: ".next-e2e-real"');
    expect(source).toContain(
      "rmSync(resolve(runtimeEnv.AURORA_NEXT_DIST_DIR), { recursive: true, force: true })",
    );
    expect(source.match(/rmSync\(resolve\(runtimeEnv\.AURORA_NEXT_DIST_DIR\)/gu)).toHaveLength(1);
    expect(source).toContain('NODE_ENV: "production"');
    expect(source).toContain('["run", "build"]');
    expect(source).toContain('["run", "start", "--", "-H", "127.0.0.1"');
    expect(source).not.toContain('["run", "dev"');
    expect(source).not.toContain(".next-e2e-real-${distSuffix}");
  });

  it("uses an HTTPS browser origin and fails on first-party 5xx responses", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain("const baseUrl = `https://127.0.0.1:${webPort}`");
    expect(source).toContain("await startHttpsProxy()");
    expect(source).toContain('kind: "http.5xx"');
    expect(source).toContain("unexpectedRuntimeLogLines()");
  });

  it("accepts the visible save summary when a resolved error collapses its details", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain('const summary = await protection.locator("summary").textContent()');
    expect(source).toContain('summary?.includes("Сохранено") === true');
    expect(source).toContain('select text from drafts where id = $1 and project_id = $2');
  });

  it("gives cold API compilation the same bounded budget as runtime readiness", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");
    const explicitBudgets = source.match(/timeout: API_REQUEST_TIMEOUT_MS/gu) ?? [];

    expect(source).toContain("const API_REQUEST_TIMEOUT_MS = RUNTIME_WAIT_TIMEOUT_MS");
    expect(explicitBudgets.length).toBeGreaterThanOrEqual(6);
  });

  it("reserves dynamic ports instead of relying on shared runner defaults", () => {
    const source = readFileSync(resolve("scripts/test-e2e-real.mjs"), "utf8");

    expect(source).toContain("async function reserveEphemeralPorts(count)");
    expect(source).toContain('server.listen(0, "127.0.0.1", resolveListen)');
    expect(source).toContain('configuredPort("E2E_WEB_PORT")');
    expect(source).toContain('configuredPort("E2E_NEXT_PORT")');
    expect(source).toContain('configuredPort("E2E_FAKE_PORT")');
    expect(source).not.toContain("process.env.E2E_WEB_PORT || 43190");
    expect(source).not.toContain("process.env.E2E_FAKE_PORT || 43191");
  });

  it("opts experimental-route E2E harnesses into preview without opening production", () => {
    for (const script of ["scripts/test-e2e-real.mjs", "scripts/test-trends-hydration-e2e.mjs"]) {
      const source = readFileSync(resolve(script), "utf8");
      expect(source).toContain('NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES: "1"');
    }
  });
});
