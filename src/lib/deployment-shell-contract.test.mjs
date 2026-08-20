import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = await readFile(resolve("scripts/deploy-production.sh"), "utf8");
const workflow = await readFile(resolve(".github/workflows/deploy-production.yml"), "utf8");
const workflowDirectory = resolve(".github/workflows");

describe("production deployment shell contract", () => {
  it("keeps build and migration failures before the live symlink switch", () => {
    const build = script.indexOf("npm run build");
    const migrate = script.indexOf("npm run db:migrate");
    const state = script.indexOf("rollback-compatible\" > \"$state_file");
    const swap = script.indexOf('swap_current "$release"');
    expect(build).toBeGreaterThan(0);
    expect(migrate).toBeGreaterThan(build);
    expect(state).toBeGreaterThan(migrate);
    expect(swap).toBeGreaterThan(state);
  });

  it("rolls back restart, health, and partial web/worker activation failures", () => {
    expect(script).toContain("if ! systemctl restart aurora-web.service aurora-worker.service");
    expect(script).toContain("if ! wait_for_health");
    expect(script).toContain("if ! services_active");
    expect(script).toContain("systemctl is-active --quiet aurora-web.service");
    expect(script).toContain("systemctl is-active --quiet aurora-worker.service");
    expect(script.split('rollback_to "$previous" || true')).toHaveLength(4);
  });

  it("makes full smoke failure invoke the remote schema-boundary rollback", () => {
    expect(workflow).toContain("if npm run test:deployment-smoke; then");
    expect(workflow).toContain("AURORA_DEPLOY_ACTION=rollback");
    expect(workflow).toContain("schema-boundary-verified rollback");
  });

  it("autodeploys only the exact main SHA that completed CI successfully", () => {
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain('workflows: ["CI"]');
    expect(workflow).toContain("branches: [main]");
    expect(workflow).toContain("types: [completed]");
    expect(workflow).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(workflow).toContain("vars.AUTO_DEPLOY_ENABLED == 'true'");
    expect(workflow).toContain("ref: ${{ github.event.workflow_run.head_sha || github.sha }}");
    expect(workflow).toContain("AURORA_DEPLOY_SHA: ${{ github.event.workflow_run.head_sha || github.sha }}");
  });

  it("fails closed before deploy writes when readiness or rollback evidence is missing", () => {
    const preflight = workflow.indexOf("Verify current production readiness before deploy");
    const configureSsh = workflow.indexOf("Configure SSH");
    const boundary = workflow.indexOf("Verify exact rollback boundary");
    const deploy = workflow.indexOf("Deploy release");
    expect(preflight).toBeGreaterThan(0);
    expect(configureSsh).toBeGreaterThan(preflight);
    expect(boundary).toBeGreaterThan(configureSsh);
    expect(deploy).toBeGreaterThan(boundary);
    expect(workflow).toContain('expected="${current_sha}:${AURORA_DEPLOY_SHA}"');
    expect(workflow).toContain('[[ "$AURORA_SCHEMA_ROLLBACK_AUDIT" == "$expected" ]]');
  });

  it("allows only the explicit degraded-mail release profile override", () => {
    expect(workflow).toContain("vars.ALLOW_DEGRADED_MAIL == 'true'");
    expect(workflow.match(/AURORA_DEPLOYMENT_SMOKE_PROFILE:/gu)).toHaveLength(2);
    expect(workflow.match(/&& 'release' \|\| 'full'/gu)).toHaveLength(2);
  });

  it("verifies CI, immutable actions, pinned host identity, and rollback compatibility", () => {
    expect(workflow).toContain("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(workflow).toContain("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
    expect(workflow).toContain("verify-required-ci-checks.mjs");
    expect(workflow).not.toContain("ssh-keyscan");
    expect(workflow).toContain("PRODUCTION_SSH_HOST_FINGERPRINT");
    expect(workflow).toContain("verify-ssh-host-identity.sh");
    expect(script.indexOf("verify-rollback-boundary.mjs")).toBeLessThan(script.indexOf("npm run db:migrate"));
  });

  it("pins every external action in every workflow to an immutable commit", async () => {
    const files = (await readdir(workflowDirectory)).filter((name) => /\.ya?ml$/u.test(name));
    const mutable = [];
    for (const file of files) {
      const source = await readFile(resolve(workflowDirectory, file), "utf8");
      for (const match of source.matchAll(/^\s*uses:\s+[^\s@]+@([^\s#]+)/gmu)) {
        if (!/^[a-f0-9]{40}$/u.test(match[1])) mutable.push(`${file}:${match[0].trim()}`);
      }
    }
    expect(mutable).toEqual([]);
  });

  it("binds every SSH workflow to pre-provisioned host identity", async () => {
    const files = (await readdir(workflowDirectory)).filter((name) => /\.ya?ml$/u.test(name));
    for (const file of files) {
      const source = await readFile(resolve(workflowDirectory, file), "utf8");
      if (!source.includes("PRODUCTION_SSH_HOST")) continue;
      expect(source, file).not.toContain("ssh-keyscan");
      expect(source, file).toContain("PRODUCTION_SSH_KNOWN_HOSTS");
      expect(source, file).toContain("PRODUCTION_SSH_HOST_FINGERPRINT");
      expect(source, file).toContain("verify-ssh-host-identity.sh");
      expect(source, file).toContain("StrictHostKeyChecking=yes");
    }
  });

  it("preserves the guarded remote retention default from current main", () => {
    expect(script).toContain('KEEP_RELEASES="${AURORA_KEEP_RELEASES:-2}"');
  });
});
