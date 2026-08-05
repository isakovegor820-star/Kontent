import { createHash } from "node:crypto";

import type { ProfileUpdate } from "./profile";

/** Server-only fingerprint for an idempotent profile mutation. */
export function profileUpdateFingerprint(input: Omit<ProfileUpdate, "requestKey">): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}
