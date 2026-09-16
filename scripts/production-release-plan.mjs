import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function assertReleaseSha(value) {
  if (!/^[0-9a-f]{40}$/u.test(String(value || ""))) {
    throw new Error("Release identity must be an exact lowercase 40-character commit SHA");
  }
  return value;
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
}

function assertCommit(cwd, sha) {
  assertReleaseSha(sha);
  if (git(cwd, ["cat-file", "-t", sha]) !== "commit") {
    throw new Error(`Release object is not a commit: ${sha}`);
  }
}

function isAncestor(cwd, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd, encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`Unable to establish release ancestry: ${result.stderr.trim()}`);
  }
  return result.status === 0;
}

export function validateReleaseTarget({ cwd, targetSha, mainRef = "refs/remotes/origin/main" }) {
  assertCommit(cwd, targetSha);
  if (!isAncestor(cwd, targetSha, mainRef)) {
    throw new Error("Release target must belong to main; feature branches cannot be deployed");
  }
  return targetSha;
}

// Comparing only schemaVersion or migration counts misses edited SQL, migration
// policy and deployment code. Compare blob identities of the complete boundary.
function schemaBoundary(cwd, sha) {
  const entries = git(cwd, ["ls-tree", "-r", "-z", sha]).split("\0").filter(Boolean);
  const files = entries.map((entry) => {
    const [metadata, path] = entry.split("\t");
    return { metadata, path };
  });
  for (const required of ["db/schema.sql", "src/lib/schema-manifest.mjs", "scripts/migrate.mjs",
    "scripts/migration-policy.mjs", "scripts/run-production-migrations.sh", "scripts/deploy-production.sh",
    "scripts/verify-rollback-boundary.mjs"]) {
    if (!files.some((file) => file.path === required && file.metadata.startsWith("100644 blob "))) {
      // Executable shell scripts are valid too; symlinks and absent files are not.
      if (!files.some((file) => file.path === required && file.metadata.startsWith("100755 blob "))) {
        throw new Error(`Cannot prove rollback boundary: missing regular file ${required} at ${sha}`);
      }
    }
  }
  return files.filter(({ path }) => path.startsWith("db/")
    || path.startsWith("src/lib/schema-")
    || path === "scripts/deploy-production.sh"
    || (path.startsWith("scripts/") && /migrat|schema|rollback/u.test(path)))
    .map(({ metadata, path }) => `${metadata}\t${path}`).sort().join("\n");
}

export function planProductionRelease({ cwd, currentSha, targetSha, attestation = "" }) {
  validateReleaseTarget({ cwd, targetSha });
  assertCommit(cwd, currentSha);
  if (currentSha === targetSha) {
    return { deploy: false, reason: "already_deployed", currentSha, targetSha, rollbackAudit: "" };
  }
  if (isAncestor(cwd, targetSha, currentSha)) {
    return { deploy: false, reason: "superseded_by_production", currentSha, targetSha, rollbackAudit: "" };
  }
  if (!isAncestor(cwd, currentSha, targetSha)) {
    throw new Error("Production and target have diverged; refusing a non-forward release");
  }
  const unchanged = schemaBoundary(cwd, currentSha) === schemaBoundary(cwd, targetSha);
  const expected = `${currentSha}:${targetSha}`;
  if (!unchanged && attestation !== expected) {
    throw new Error(`Schema/migration/deploy boundary changed; SCHEMA_ROLLBACK_AUDIT must equal the rehearsed current:target pair: ${expected}`);
  }
  return {
    deploy: true,
    reason: unchanged ? "schema_boundary_unchanged" : "exact_rollback_audit",
    currentSha,
    targetSha,
    // A stale shared variable is irrelevant when the complete boundary is unchanged.
    rollbackAudit: unchanged ? "" : expected,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cwd = process.cwd();
  const targetSha = process.env.AURORA_DEPLOY_SHA;
  if (process.argv[2] === "validate-target") {
    validateReleaseTarget({ cwd, targetSha });
    console.log(`[deploy] target on main: ${targetSha}`);
  } else if (process.argv[2] === "plan") {
    const plan = planProductionRelease({
      cwd, targetSha,
      currentSha: process.env.AURORA_CURRENT_SHA,
      attestation: process.env.AURORA_SCHEMA_ROLLBACK_AUDIT || "",
    });
    if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required");
    appendFileSync(process.env.GITHUB_OUTPUT, [
      `deploy=${plan.deploy}`, `reason=${plan.reason}`, `current_sha=${plan.currentSha}`,
      `target_sha=${plan.targetSha}`, `rollback_audit=${plan.rollbackAudit}`, "",
    ].join("\n"));
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY,
        `## Release decision\n\nTarget: \`${plan.targetSha}\`\n\nProduction: \`${plan.currentSha}\`\n\nDecision: **${plan.reason}**\n`);
    }
    console.log(`[deploy] ${plan.reason}: ${plan.currentSha} -> ${plan.targetSha}`);
  } else {
    throw new Error("Expected validate-target or plan");
  }
}
