import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { verifyRequiredChecks } from "../../scripts/verify-required-ci-checks.mjs";
import { evaluateRollbackBoundary } from "../../scripts/verify-rollback-boundary.mjs";

const previousSha = "a".repeat(40);
const targetSha = "b".repeat(40);
const migration = (name, checksum = "c".repeat(64)) => ({ name, checksum });
const hostIdentityVerifier = resolve("scripts/verify-ssh-host-identity.sh");

describe("production deployment safety gates", () => {
  it("requires every named CI check to have a latest successful completion", () => {
    const payload = { check_runs: [
      { name: "lint", status: "completed", conclusion: "success", completed_at: "2026-08-20T10:00:00Z" },
      { name: "tests", status: "completed", conclusion: "failure", completed_at: "2026-08-20T09:00:00Z" },
      { name: "tests", status: "completed", conclusion: "success", completed_at: "2026-08-20T10:00:00Z" },
    ] };
    expect(verifyRequiredChecks(payload, "lint,tests")).toEqual(["lint", "tests"]);
    expect(() => verifyRequiredChecks(payload, "lint,build")).toThrow("build:missing");
    expect(() => verifyRequiredChecks({ check_runs: [
      { name: "tests", status: "in_progress", conclusion: null },
    ] }, "tests")).toThrow("in_progress/none");
  });

  it("allows unchanged schema rollback without an attestation", () => {
    const manifest = { migrations: [migration("one.sql")] };
    expect(evaluateRollbackBoundary({ previousManifest: manifest, targetManifest: manifest,
      previousSha, targetSha, attestation: "" })).toMatchObject({ compatible: true, reason: "schema_unchanged" });
  });

  it("blocks schema-changing rollback unless the protected audit names the exact SHA pair", () => {
    const previousManifest = { migrations: [migration("one.sql")] };
    const targetManifest = { migrations: [migration("one.sql"), migration("two.sql")] };
    expect(evaluateRollbackBoundary({ previousManifest, targetManifest, previousSha, targetSha,
      attestation: "" })).toMatchObject({ compatible: false });
    expect(evaluateRollbackBoundary({ previousManifest, targetManifest, previousSha, targetSha,
      attestation: `${previousSha}:${"d".repeat(40)}` })).toMatchObject({ compatible: false });
    expect(evaluateRollbackBoundary({ previousManifest, targetManifest, previousSha, targetSha,
      attestation: `${previousSha}:${targetSha}` })).toMatchObject({
        compatible: true,
        reason: "externally_audited_schema_boundary",
      });
  });

  it("accepts only the fingerprint bound to the configured production host", () => {
    const directory = mkdtempSync(join(tmpdir(), "aurora-host-identity-"));
    try {
      const productionKey = join(directory, "production");
      const unrelatedKey = join(directory, "unrelated");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", productionKey]);
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", unrelatedKey]);
      const knownHosts = join(directory, "known_hosts");
      writeFileSync(
        knownHosts,
        `production.example ${readFileSync(`${productionKey}.pub`, "utf8").trim()}\n`
          + `unrelated.example ${readFileSync(`${unrelatedKey}.pub`, "utf8").trim()}\n`,
      );
      const fingerprint = (publicKey) => execFileSync(
        "ssh-keygen",
        ["-lf", publicKey, "-E", "sha256"],
        { encoding: "utf8" },
      ).trim().split(/\s+/u)[1];
      const productionFingerprint = fingerprint(`${productionKey}.pub`);
      const unrelatedFingerprint = fingerprint(`${unrelatedKey}.pub`);

      expect(spawnSync(
        "bash",
        [hostIdentityVerifier, knownHosts, "production.example", productionFingerprint],
        { encoding: "utf8" },
      ).status).toBe(0);
      const wrongHostKey = spawnSync(
        "bash",
        [hostIdentityVerifier, knownHosts, "production.example", unrelatedFingerprint],
        { encoding: "utf8" },
      );
      expect(wrongHostKey.status).not.toBe(0);
      expect(wrongHostKey.stderr).toContain("fingerprint does not match the configured host");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
