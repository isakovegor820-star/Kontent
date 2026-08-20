import { pathToFileURL } from "node:url";

function migrationIdentity(migration) {
  return `${String(migration?.name || "")}:${String(migration?.checksum || "")}`;
}

export function evaluateRollbackBoundary(input) {
  const previous = Array.isArray(input.previousManifest?.migrations)
    ? input.previousManifest.migrations.map(migrationIdentity)
    : [];
  const target = Array.isArray(input.targetManifest?.migrations)
    ? input.targetManifest.migrations.map(migrationIdentity)
    : [];
  if (previous.length === 0 || target.length === 0) {
    return { compatible: false, reason: "schema_manifest_missing" };
  }
  if (JSON.stringify(previous) === JSON.stringify(target)) {
    return { compatible: true, reason: "schema_unchanged" };
  }
  const exactAudit = `${input.previousSha}:${input.targetSha}`;
  if (/^[0-9a-f]{40}:[0-9a-f]{40}$/u.test(exactAudit) && input.attestation === exactAudit) {
    return { compatible: true, reason: "externally_audited_schema_boundary" };
  }
  return {
    compatible: false,
    reason: "schema_changed_without_exact_rollback_audit",
    expectedAttestation: exactAudit,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [previousManifestUrl, targetManifestUrl, previousSha, targetSha] = process.argv.slice(2);
  if (!previousManifestUrl || !targetManifestUrl || !previousSha || !targetSha) {
    throw new Error("previous manifest, target manifest, previous SHA, and target SHA are required");
  }
  const previousManifest = (await import(pathToFileURL(previousManifestUrl).href)).SCHEMA_MANIFEST;
  const targetManifest = (await import(pathToFileURL(targetManifestUrl).href)).SCHEMA_MANIFEST;
  const result = evaluateRollbackBoundary({
    previousManifest,
    targetManifest,
    previousSha,
    targetSha,
    attestation: String(process.env.AURORA_SCHEMA_ROLLBACK_AUDIT || "").trim(),
  });
  if (!result.compatible) {
    throw new Error(`${result.reason}; expected protected audit ${result.expectedAttestation || "unavailable"}`);
  }
  console.log(`[deploy] rollback boundary: ${result.reason}`);
}
