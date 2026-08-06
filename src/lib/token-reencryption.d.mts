import type { Pool } from "pg";
export function tokenEnvelopeKeyReadiness(
  pool: Pick<Pool, "query">,
  env?: NodeJS.ProcessEnv,
): Promise<{ state: "up" | "down" | "not_configured"; unknownKeyIds: string[] }>;
export function reencryptTokenBatch(input: {
  pool: Pick<Pool, "connect">;
  batchSize?: number;
}): Promise<{ currentKeyId: string; reencrypted: number; bySource: Record<string, number> }>;
