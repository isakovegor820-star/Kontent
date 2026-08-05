import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { migrationBody, prepareMigrationSet } from "./migration-policy.mjs";

const LOCK_ID = 1_972_475_321;
const STATEMENT_TIMEOUT_MS = 300_000;
const LOCK_TIMEOUT_MS = 10_000;
export const REQUIRED_BASELINE_TABLES = Object.freeze([
  "users",
  "sessions",
  "channels",
  "posts",
  "post_stats",
  "ai_usage",
  "saved_posts",
  "hashtag_sets",
  "competitor_posts",
  "rss_feeds",
  "rss_items",
  "autopilot_plan",
  "content_brief",
  "media_generations",
]);

export function migrationChecksum(sql) {
  return createHash("sha256").update(String(sql), "utf8").digest("hex");
}

export { migrationBody };

export class DatabaseNotBootstrappedError extends Error {
  constructor(missing) {
    super(
      `database is not bootstrapped; refusing to run incremental migrations (missing: ${missing.join(", ")})`,
    );
    this.name = "DatabaseNotBootstrappedError";
    this.missing = [...missing];
  }
}

function poolOptions(connectionString, env) {
  const local = /\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::|\/)/u.test(connectionString);
  return {
    connectionString,
    ssl: local ? false : { rejectUnauthorized: env.PGSSL_REJECT_UNAUTHORIZED !== "false" },
    max: 1,
    connectionTimeoutMillis: 5_000,
  };
}

export async function assertBootstrappedDatabase(client) {
  const missing = (
    await client.query(
      `select required.name
         from unnest($1::text[]) as required(name)
        where to_regclass('public.' || quote_ident(required.name)) is null
        order by required.name`,
      [REQUIRED_BASELINE_TABLES],
    )
  ).rows.map((row) => String(row.name)).sort();
  if (missing.length > 0) {
    throw new DatabaseNotBootstrappedError(missing);
  }
}

async function migrationsFrom(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(resolve(directory, name), "utf8") })),
  );
}

export async function migrate(options = {}) {
  const env = options.env || process.env;
  const directory = options.directory || resolve(process.cwd(), "db/migrations");
  const inputMigrations = options.migrations || (await migrationsFrom(directory));
  // This complete, filesystem-only policy pass intentionally happens before Pool creation.
  const migrations = prepareMigrationSet(inputMigrations);
  const connectionString = String(env.DATABASE_URL || "").trim();
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const createPool = options.poolFactory || ((config) => new Pool(config));
  const logger = options.logger || console;
  const pool = createPool(poolOptions(connectionString, env));
  let client;
  let lockHeld = false;
  let primaryError;
  try {
    client = await pool.connect();
    await client.query(
      "select set_config('statement_timeout', $1, false), set_config('lock_timeout', $2, false)",
      [`${STATEMENT_TIMEOUT_MS}ms`, `${LOCK_TIMEOUT_MS}ms`],
    );
    await assertBootstrappedDatabase(client);

    const lock = await client.query("select pg_try_advisory_lock($1) as acquired", [LOCK_ID]);
    if (lock.rows[0]?.acquired !== true) {
      throw new Error("another migration runner holds the advisory lock; refusing to wait");
    }
    lockHeld = true;

    await client.query(`create table if not exists schema_migrations (
      name text primary key,
      checksum char(64) not null,
      applied_at timestamptz not null default now()
    )`);

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration.sql);
      const existing = (
        await client.query("select checksum from schema_migrations where name = $1", [migration.name])
      ).rows[0];
      if (existing) {
        if (existing.checksum !== checksum) {
          throw new Error(`${migration.name}: checksum changed after application`);
        }
        continue;
      }

      await client.query("begin");
      try {
        await client.query(migration.body);
        await client.query(
          "insert into schema_migrations (name, checksum) values ($1, $2)",
          [migration.name, checksum],
        );
        await client.query("commit");
        logger.log(`[migrate] applied ${migration.name}`);
      } catch (error) {
        await client.query("rollback").catch(() => {});
        throw error;
      }
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError;
    if (client) {
      if (lockHeld) {
        await client
          .query("select pg_advisory_unlock($1)", [LOCK_ID])
          .catch((error) => (cleanupError ||= error));
      }
      try {
        client.release();
      } catch (error) {
        cleanupError ||= error;
      }
    }
    try {
      await pool.end();
    } catch (error) {
      cleanupError ||= error;
    }
    if (!primaryError && cleanupError) throw cleanupError;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate().catch((error) => {
    console.error("[migrate] failed", { name: error instanceof Error ? error.name : "error" });
    process.exitCode = 1;
  });
}
