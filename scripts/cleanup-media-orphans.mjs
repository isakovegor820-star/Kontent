import pg from "pg";

import { cleanupMediaObjectOrphans } from "../src/lib/media-storage.mjs";

const connectionString = String(process.env.DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new pg.Pool({ connectionString, max: 2 });
try {
  const result = await cleanupMediaObjectOrphans({
    pool,
    limit: Number(process.env.MEDIA_ORPHAN_CLEANUP_BATCH_SIZE || 25),
  });
  console.log("[media_orphan_cleanup]", result);
} finally {
  await pool.end();
}
