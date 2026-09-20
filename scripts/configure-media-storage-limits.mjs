import pg from "pg";
import { configureMediaStorageLimits } from "../src/lib/media-storage-quota.mjs";
const databaseUrl = process.env.MEDIA_QUOTA_DATABASE_URL;
if (!databaseUrl) throw new Error("MEDIA_QUOTA_DATABASE_URL is required; .env is never loaded");
const apply = process.argv.includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply")) throw new Error("only --apply is accepted; default is dry-run");
const target = new URL(databaseUrl);
if (apply && (!["localhost","127.0.0.1","[::1]"].includes(target.hostname) || !/^\/aurora_[a-z0-9_]+_test$/u.test(target.pathname))) throw new Error("apply_requires_disposable_local_database");
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  console.log(JSON.stringify(await configureMediaStorageLimits(pool, {
    userMaxBytes: process.env.MEDIA_USER_MAX_BYTES,
    projectMaxBytes: process.env.MEDIA_PROJECT_MAX_BYTES,
    globalMaxBytes: process.env.MEDIA_GLOBAL_MAX_BYTES,
  }, { apply }), null, 2));
} finally { await pool.end(); }
