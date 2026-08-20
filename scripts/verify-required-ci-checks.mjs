import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function verifyRequiredChecks(payload, requiredValue) {
  const required = String(requiredValue || "")
    .split(/[\n,]/u)
    .map((name) => name.trim())
    .filter(Boolean);
  if (required.length === 0) throw new Error("AURORA_REQUIRED_CI_CHECKS is required");
  const runs = Array.isArray(payload?.check_runs) ? payload.check_runs : [];
  const failures = [];
  for (const name of required) {
    const matches = runs.filter((run) => String(run?.name || "") === name);
    if (matches.length === 0) {
      failures.push(`${name}:missing`);
      continue;
    }
    const latest = matches.toSorted((left, right) => (
      Date.parse(String(right?.completed_at || right?.started_at || 0))
      - Date.parse(String(left?.completed_at || left?.started_at || 0))
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
  const required = verifyRequiredChecks(payload, process.env.AURORA_REQUIRED_CI_CHECKS);
  console.log(`[deploy] required CI checks successful: ${required.join(", ")}`);
}
