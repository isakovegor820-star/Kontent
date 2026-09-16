import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const deploy = readFileSync(new URL("../../.github/workflows/deploy-production.yml", import.meta.url), "utf8");
const required = ["checks", "e2e-build", "e2e", "trends-hydration"];
const aggregate = workflow.slice(workflow.indexOf("\n  build:\n"));
const gate = aggregate.match(/node --input-type=module <<'NODE'\n([\s\S]+?)\n\s+NODE/u)?.[1];
const allPassed = Object.fromEntries(required.map((job) => [job, { result: "success" }]));

function check(results) {
  return spawnSync(process.execPath, ["--input-type=module"], {
    input: gate,
    encoding: "utf8",
    env: { ...process.env, CI_RESULTS: JSON.stringify(results) },
  });
}

describe("parallel CI release gate", () => {
  it("runs the actual aggregate script and requires every branch, not just the fast checks", () => {
    expect(gate).toBeTruthy();
    expect(aggregate).toContain("if: always()");
    expect(aggregate).toContain(`needs: [${required.join(", ")}]`);
    expect(check(allPassed).status).toBe(0);
    for (const job of required) {
      for (const result of ["failure", "cancelled", "skipped", "", null]) {
        const outcome = check({ ...allPassed, [job]: { result } });
        expect(outcome.status, `${job}:${result}`).toBe(1);
        expect(outcome.stderr).toContain(job);
      }
      const missing = { ...allPassed };
      delete missing[job];
      expect(check(missing).status).toBe(1);
    }
  });

  it("keeps three independent browser jobs on the same tested build and preserves main candidates", () => {
    const browsers = workflow.slice(workflow.indexOf("\n  e2e:\n"), workflow.indexOf("\n  trends-hydration:\n"));
    expect(browsers).toContain("browser: [chromium, firefox, webkit]");
    expect(browsers).toContain("fail-fast: false");
    expect(browsers).toContain("services:");
    expect(browsers).toContain("POSTGRES_DB: aurora_e2e_real");
    expect(browsers).toContain("E2E_BUILD_MODE: reuse");
    expect(browsers).not.toContain("--build-only");
    expect(workflow.match(/name: e2e-runtime-\$\{\{ github.sha \}\}/gu)).toHaveLength(2);
    expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(deploy).toContain("AURORA_REQUIRED_CI_CHECKS: build,");
  });

  it("gates every release mutation on the forward-release decision and keeps orchestration trusted", () => {
    for (const name of ["Checkout pinned application commit", "Build production release artifact", "Deploy release", "Verify production deployment"]) {
      expect(deploy).toContain(`- name: ${name}\n        if: steps.release.outputs.deploy == 'true'`);
    }
    const preserve = deploy.indexOf('cp scripts/deploy-production.sh "${RUNNER_TEMP}/aurora-deploy-production.sh"');
    expect(preserve).toBeGreaterThan(0);
    expect(preserve).toBeLessThan(deploy.indexOf('git checkout --detach "$AURORA_DEPLOY_SHA"'));
    expect(deploy.match(/< "\$\{RUNNER_TEMP\}\/aurora-deploy-production.sh"/gu)).toHaveLength(2);
    expect(deploy).toContain("cancel-in-progress: false");
  });
});
