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
const resetPublic = async () => {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
};
try {
  const occupied = await pool.query(
    `select count(*)::int as n from pg_tables where schemaname = 'public'`,
  );
  if (Number(occupied.rows[0]?.n ?? 0) !== 0) {
    throw new Error("aurora_migration_test must be an empty disposable database");
  }
  const fixture = await readFile(resolve("db/fixtures/legacy-migration.sql"), "utf8");
  const freshSchema = await readFile(resolve("db/schema.sql"), "utf8");
  const migrationFiles = (await readdir(resolve("db/migrations")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  await pool.query(fixture);
  const acceptedLegacyHasSuggestions = await pool.query(
    "select to_regclass('public.competitor_suggestions') is not null as present",
  );
  if (acceptedLegacyHasSuggestions.rows[0]?.present !== false) {
    throw new Error("legacy fixture must prove recovery from a missing competitor_suggestions table");
  }

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
       (select count(*)::int from content_brief where source = 'quiz') as quiz_briefs,
       (select count(*)::int from information_schema.columns
         where table_schema = 'public' and table_name = 'competitor_suggestions'
           and column_name in ('channel_id','description','last_post_at','posts_per_week','on_topic'))
         as suggestion_columns`,
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
    || Number(summary.suggestion_columns) !== 5
    || byId.get(101)?.external_message_id !== "77"
    || byId.get(102)?.external_message_id !== null
    || byId.get(102)?.result !== "duplicate_legacy_external_id"
    || byId.get(103)?.external_message_id !== "77"
  ) {
    throw new Error(`migration integration assertions failed: ${JSON.stringify({ posts: posts.rows, summary })}`);
  }

  // A partially provisioned table keeps its row while the additive baseline fills the
  // missing channel/activity columns and constraints.
  await resetPublic();
  await pool.query(fixture);
  await pool.query(`create table competitor_suggestions (
    id bigint generated always as identity primary key,
    user_id bigint not null references users (id) on delete cascade,
    handle text not null,
    title text,
    mentioned_by int not null default 1,
    status text not null default 'new',
    found_at timestamptz not null default now()
  )`);
  await pool.query(
    "insert into competitor_suggestions (user_id, handle, title) values (1, 'legacy_peer', 'Legacy peer')",
  );
  await migrate({ env, logger: { log() {} } });
  await migrate({ env, logger: { log() {} } });
  const partialSuggestion = (await pool.query(
    `select channel_id, title, description, last_post_at, posts_per_week, on_topic
       from competitor_suggestions where handle = 'legacy_peer'`,
  )).rows[0];
  if (Number(partialSuggestion?.channel_id) !== 10 || partialSuggestion?.title !== "Legacy peer") {
    throw new Error(`partial competitor_suggestions row was not preserved: ${JSON.stringify(partialSuggestion)}`);
  }

  // A fresh monolithic bootstrap already contains every column/constraint. Applying the
  // complete migration set twice must remain a no-op for data and schema.
  await resetPublic();
  await pool.query(freshSchema);
  await migrate({ env, logger: { log() {} } });
  await migrate({ env, logger: { log() {} } });
  const freshMigrationCount = Number((await pool.query(
    "select count(*)::int as count from schema_migrations",
  )).rows[0]?.count ?? 0);
  if (freshMigrationCount !== migrationFiles.length) {
    throw new Error(`fresh schema applied ${freshMigrationCount}/${migrationFiles.length} migrations`);
  }

  // Runner-level regression: a SQL failure rolls back both DDL and its migration record.
  const rollbackProbe = {
    name: "20991231_rollback_probe.sql",
    sql: "begin;\ncreate table migration_rollback_probe (id int);\nselect * from migration_probe_missing;\ncommit;\n",
  };
  await migrate({ env, migrations: [rollbackProbe], logger: { log() {} } })
    .then(() => { throw new Error("rollback probe unexpectedly succeeded"); })
    .catch((error) => {
      if (!String(error?.message || "").includes("migration_probe_missing")) throw error;
    });
  const rollbackState = (await pool.query(
    `select to_regclass('public.migration_rollback_probe') as relation,
            exists(select 1 from schema_migrations where name = $1) as recorded`,
    [rollbackProbe.name],
  )).rows[0];
  if (rollbackState?.relation !== null || rollbackState?.recorded !== false) {
    throw new Error(`failed migration was not rolled back: ${JSON.stringify(rollbackState)}`);
  }

  // An applied filename with different bytes must fail closed without changing its row.
  const firstName = migrationFiles[0];
  const firstSql = await readFile(resolve("db/migrations", firstName), "utf8");
  const changedSql = firstSql.replace(/commit\s*;\s*$/iu, "-- checksum probe\ncommit;\n");
  await migrate({
    env,
    migrations: [{ name: firstName, sql: changedSql }],
    logger: { log() {} },
  }).then(() => { throw new Error("checksum probe unexpectedly succeeded"); })
    .catch((error) => {
      if (!String(error?.message || "").includes("checksum changed after application")) throw error;
    });

  console.log(
    `[migrate:integration] ${summary.migrations}/${migrationFiles.length} migrations; legacy, partial and fresh schemas preserved; rollback/checksum fail closed`,
  );
} finally {
  await pool.end();
}
