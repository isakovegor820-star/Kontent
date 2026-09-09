import { pathToFileURL } from "node:url";

function migrationIdentity(migration) {
  return `${String(migration?.name || "")}:${String(migration?.checksum || "")}`;
}

function exactSha(value) {
  return /^[0-9a-f]{40}$/u.test(String(value || ""));
}

export function evaluateForwardOnlyBoundary(input) {
  const previous = Array.isArray(input.previousManifest?.migrations)
    ? input.previousManifest.migrations.map(migrationIdentity)
    : [];
  const target = Array.isArray(input.targetManifest?.migrations)
    ? input.targetManifest.migrations.map(migrationIdentity)
    : [];
  if (previous.length === 0 || target.length === 0) {
    return { safe: false, reason: "schema_manifest_missing" };
  }
  if (!exactSha(input.previousSha) || !exactSha(input.targetSha)) {
    return { safe: false, reason: "release_sha_invalid" };
  }
  if (previous.some((identity, index) => target[index] !== identity)) {
    return { safe: false, reason: "migration_history_not_additive" };
  }
  const expectedAttestation = `${input.previousSha}:${input.targetSha}:forward-only`;
  if (input.attestation !== expectedAttestation) {
    return {
      safe: false,
      reason: "forward_only_cutover_not_attested",
      expectedAttestation,
    };
  }
  return {
    safe: true,
    reason: previous.length === target.length
      ? "schema_unchanged_forward_only_attested"
      : "additive_schema_forward_only_attested",
    expectedAttestation,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [previousManifestUrl, targetManifestUrl, previousSha, targetSha] = process.argv.slice(2);
  if (!previousManifestUrl || !targetManifestUrl || !previousSha || !targetSha) {
    throw new Error("previous manifest, target manifest, previous SHA and target SHA are required");
  }
  const result = evaluateForwardOnlyBoundary({
    previousManifest: await import(pathToFileURL(previousManifestUrl).href),
    targetManifest: await import(pathToFileURL(targetManifestUrl).href),
    previousSha,
    targetSha,
    attestation: String(process.env.AURORA_SCHEMA_FORWARD_ONLY_AUDIT || "").trim(),
  });
  if (!result.safe) {
    throw new Error(
      `${result.reason}; expected protected audit ${result.expectedAttestation || "unavailable"}`,
    );
  }
  console.log(`[deploy] forward-only boundary: ${result.reason}`);
}
