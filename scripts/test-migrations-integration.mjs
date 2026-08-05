import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { migrate } from "./migrate.mjs";

const connectionString = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
if (!connectionString) throw new Error("MIGRATION_TEST_DATABASE_URL is required");
const parsed = new URL(connectionString);
if (
  !["localhost", "127.0.0.1"].includes(parsed.hostname)
  || parsed.pathname.replace(/^\//u, "") !== "aurora_migration_test"
) {
  throw new Error("migration integration test requires local database aurora_migration_test");
}

const pool = new pg.Pool({ connectionString, ssl: false, max: 1 });
try {
  const occupied = await pool.query(
    `select count(*)::int as n from pg_tables where schemaname = 'public'`,
  );
  if (Number(occupied.rows[0]?.n ?? 0) !== 0) {
    throw new Error("aurora_migration_test must be an empty disposable database");
  }
  const fixture = await readFile(resolve("db/fixtures/legacy-migration.sql"), "utf8");
  const migrationFiles = (await readdir(resolve("db/migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  await pool.query(fixture);

  const env = { ...process.env, DATABASE_URL: connectionString };
  await migrate({ env, logger: { log() {} } });
  await migrate({ env, logger: { log() {} } });

  // Регрессия онбординга: приложение сохраняет source='quiz'. До миграции legacy
  // constraint разрешал только ai/manual и пользователь застревал на шаге 2.
  await pool.query(
    `update content_brief set source = 'quiz' where user_id = 1 and channel_id = 10`,
  );

  const posts = await pool.query(
    `select id, channel_id, status, external_message_id, verification_state,
            verification_result->>'result' as result
       from posts order by id`,
  );
  const checks = await pool.query(
    `select
       (select count(*)::int from schema_migrations) as migrations,
       (select count(*)::int from saved_posts where channel_id is null) as saved_unassigned,
       (select count(*)::int from hashtag_sets where channel_id is null) as tags_unassigned,
       (select count(*)::int from rss_items where skip_reason = 'limit') as rss_labeled,
       (select count(*)::int from ai_usage where status = 'committed') as usage_preserved,
       (select count(*)::int from content_brief where source = 'quiz') as quiz_briefs`,
  );
  const byId = new Map(posts.rows.map((row) => [Number(row.id), row]));
  const summary = checks.rows[0];
  if (
    Number(summary.migrations) !== migrationFiles.length
    || Number(summary.saved_unassigned) !== 1
    || Number(summary.tags_unassigned) !== 1
    || Number(summary.rss_labeled) !== 1
    || Number(summary.usage_preserved) !== 1
    || Number(summary.quiz_briefs) !== 1
    || byId.get(101)?.external_message_id !== "77"
    || byId.get(102)?.external_message_id !== null
    || byId.get(102)?.result !== "duplicate_legacy_external_id"
    || byId.get(103)?.external_message_id !== "77"
  ) {
    throw new Error(`migration integration assertions failed: ${JSON.stringify({ posts: posts.rows, summary })}`);
  }
  console.log(`[migrate:integration] ${summary.migrations}/${migrationFiles.length} migrations; legacy fixtures preserved`);
} finally {
  await pool.end();
}
