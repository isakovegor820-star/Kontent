import { createHash } from "node:crypto";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
}

/**
 * Stable content identity shared by the web process and background workers.
 * Editorial approvals are bound to this exact snapshot hash.
 */
export function draftRevisionContentHash(snapshot) {
  return createHash("sha256").update(JSON.stringify(canonical(snapshot)), "utf8").digest("hex");
}
