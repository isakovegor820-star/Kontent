import pg from "pg";

import { reencryptTokenBatch } from "../src/lib/token-reencryption.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL is required");
const batchSize = Number(process.env.TOKENS_REENCRYPT_BATCH_SIZE || 50);
const pool = new pg.Pool({ connectionString, max: 2 });
let total = 0;
try {
  while (true) {
    const result = await reencryptTokenBatch({ pool, batchSize });
    total += result.reencrypted;
    console.log("[token_reencryption]", {
      currentKeyId: result.currentKeyId,
      batch: result.reencrypted,
      total,
      bySource: result.bySource,
    });
    if (result.reencrypted === 0) break;
  }
} finally {
  await pool.end();
}
