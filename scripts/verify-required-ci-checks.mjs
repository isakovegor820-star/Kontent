import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function verifyRequiredChecks(payload, requiredValue, { targetSha } = {}) {
  const required = [...new Set(String(requiredValue || "")
    .split(/[\n,]/u)
    .map((name) => name.trim())
    .filter(Boolean))];
  if (required.length === 0) throw new Error("AURORA_REQUIRED_CI_CHECKS is required");
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  const failures = [];
  for (const name of required) {
    const matches = runs.filter((run) => String(run?.name || "") === name
      && (!targetSha || (run?.head_sha === targetSha && run?.app?.slug === "github-actions")));
    if (matches.length === 0) {
      failures.push(`${name}:missing`);
      continue;
    }
    // A late completion of an older run must not hide a newer queued/failed run.
    const latest = matches.toSorted((left, right) => (
      (Number(right?.id || 0) - Number(left?.id || 0))
      || (Date.parse(String(right?.started_at || right?.completed_at || 0))
        - Date.parse(String(left?.started_at || left?.completed_at || 0)))
    ))[0];
    if (latest?.status !== "completed" || latest?.conclusion !== "success") {
      failures.push(`${name}:${String(latest?.status || "unknown")}/${String(latest?.conclusion || "none")}`);
    }
  }
  if (failures.length > 0) throw new Error(`required CI checks are not successful: ${failures.join(", ")}`);
  return required;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = process.argv[2];
  if (!input) throw new Error("check-runs JSON path is required");
  const payload = JSON.parse(await readFile(input, "utf8"));
  const targetSha = process.env.AURORA_DEPLOY_SHA;
  if (!/^[0-9a-f]{40}$/u.test(String(targetSha || ""))) throw new Error("Exact AURORA_DEPLOY_SHA is required");
  const required = verifyRequiredChecks(payload, process.env.AURORA_REQUIRED_CI_CHECKS, { targetSha });
  console.log(`[deploy] required CI checks successful: ${required.join(", ")}`);
}
