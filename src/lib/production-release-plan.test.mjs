import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { planProductionRelease, validateReleaseTarget } from "../../scripts/production-release-plan.mjs";

const temporary = [];
const shell = resolve("scripts/deploy-production.sh");
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), "aurora-release-plan-"));
  temporary.push(cwd);
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release-test@aurora.test");
  const write = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  for (const path of ["db/schema.sql", "db/migrations/one.sql", "src/lib/schema-manifest.mjs",
    "scripts/migrate.mjs", "scripts/migration-policy.mjs", "scripts/run-production-migrations.sh",
    "scripts/deploy-production.sh", "scripts/verify-rollback-boundary.mjs"]) write(path, "baseline\n");
  const commit = (message) => {
    git("add", ".");
    git("commit", "-qm", message);
    const sha = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", sha);
    return sha;
  };
  const base = commit("base");
  write("src/landing.txt", "new UI\n");
  const target = commit("UI");
  return { cwd, git, write, commit, base, target };
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("pinned production release planning", () => {
  it("releases a proven unchanged boundary despite a stale shared audit variable", () => {
    const { cwd, base, target } = repo();
    expect(planProductionRelease({ cwd, currentSha: base, targetSha: target, attestation: "stale" }))
      .toEqual({ deploy: true, reason: "schema_boundary_unchanged", currentSha: base, targetSha: target, rollbackAudit: "" });
  });

  it("does not move the chosen target when newer commits arrive on main", () => {
    const { cwd, base, target, write, commit } = repo();
    write("src/unrelated.txt", "another task\n");
    commit("newer main");
    expect(planProductionRelease({ cwd, currentSha: base, targetSha: target }).targetSha).toBe(target);
  });

  it("does not rebuild, restart or downgrade an already deployed or superseded candidate", () => {
    const { cwd, base, target } = repo();
    expect(planProductionRelease({ cwd, currentSha: target, targetSha: target }))
      .toMatchObject({ deploy: false, reason: "already_deployed" });
    expect(planProductionRelease({ cwd, currentSha: target, targetSha: base }))
      .toMatchObject({ deploy: false, reason: "superseded_by_production" });
  });

  it.each(["db/migrations/one.sql", "db/schema.sql", "src/lib/schema-manifest.mjs",
    "scripts/migration-policy.mjs", "scripts/run-production-migrations.sh", "scripts/deploy-production.sh"])(
    "requires an exact external audit after changing %s, even without changing schemaVersion",
    (path) => {
      const { cwd, base, target, write, commit } = repo();
      write(path, "changed\n");
      const changed = commit("boundary change");
      expect(() => planProductionRelease({ cwd, currentSha: base, targetSha: changed }))
        .toThrow("SCHEMA_ROLLBACK_AUDIT");
      expect(() => planProductionRelease({ cwd, currentSha: base, targetSha: changed, attestation: `${base}:${target}` }))
        .toThrow("SCHEMA_ROLLBACK_AUDIT");
      expect(planProductionRelease({ cwd, currentSha: base, targetSha: changed, attestation: `${base}:${changed}` }))
        .toMatchObject({ deploy: true, reason: "exact_rollback_audit", rollbackAudit: `${base}:${changed}` });
    },
  );

  it("fails closed on incomplete evidence, invalid identities, feature branches and diverged production", () => {
    const { cwd, base, target, git, write, commit } = repo();
    expect(() => validateReleaseTarget({ cwd, targetSha: "main" })).toThrow("40-character");
    expect(() => validateReleaseTarget({ cwd, targetSha: `${target}\nother=value` })).toThrow("40-character");
    rmSync(join(cwd, "src/lib/schema-manifest.mjs"));
    const incomplete = commit("missing manifest");
    expect(() => planProductionRelease({ cwd, currentSha: base, targetSha: incomplete, attestation: `${base}:${incomplete}` }))
      .toThrow("missing regular file");
    git("checkout", "--detach", base);
    write("src/other.txt", "diverged\n");
    const feature = commit("feature");
    git("update-ref", "refs/remotes/origin/main", target);
    expect(() => validateReleaseTarget({ cwd, targetSha: feature })).toThrow("belong to main");
    expect(() => planProductionRelease({ cwd, currentSha: feature, targetSha: target })).toThrow("diverged");
  });

  it("rejects a stale production plan under the server lock before installation or cleanup", () => {
    const { cwd, base, target, write } = repo();
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    for (const [name, content] of Object.entries({
      flock: "exit 0",
      readlink: 'printf "%s\\n" "$TEST_CURRENT_PATH"',
    })) {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\n${content}\n`, { mode: 0o755 });
    }
    write("preserve.txt", "must stay\n");
    const releases = join(cwd, "releases");
    const result = spawnSync("bash", [shell], {
      encoding: "utf8",
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_CURRENT_PATH: cwd,
        AURORA_DEPLOY_SHA: target, AURORA_EXPECTED_CURRENT_SHA: base,
        AURORA_RELEASES_DIR: releases, AURORA_CURRENT_LINK: join(cwd, "current"),
        AURORA_BUILD_ARCHIVE: `/tmp/aurora-build-${target}.tar.gz`, AURORA_BUILD_ARCHIVE_SHA256: "a".repeat(64),
        AURORA_SOURCE_BUNDLE: `/tmp/aurora-source-${target}.bundle`, AURORA_SOURCE_BUNDLE_SHA256: "b".repeat(64),
        AURORA_AVATAR_BODY_LIMIT_BYTES: "10485760", AURORA_DB_POOL_MAX_WEB: "3", AURORA_DB_POOL_MAX_WORKER: "3",
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production changed after release planning");
    expect(result.stdout).not.toMatch(/CLONE|PRUNE|MIGRATE|INSTALL/u);
    expect(readdirSync(releases)).toEqual([".deploy.lock"]);
  });
});
