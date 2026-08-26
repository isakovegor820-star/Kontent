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
  const originalSessionMigration = await readFile(
    resolve("db/fixtures/20260916_session_token_hashes_original.sql"),
    "utf8",
  );
  const currentSessionMigration = await readFile(
    resolve("db/migrations/20260916_session_token_hashes.sql"),
    "utf8",
  );
  const productionLedgerAudit = await readFile(
    resolve("scripts/production-migration-ledger-audit.sql"),
    "utf8",
  );
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
       (select count(*)::int from sessions
         where token = encode(digest('live-legacy-cookie', 'sha256'), 'hex')
           and token_hash = token
           and expires_at <= now()) as invalidated_dual_sessions,
       (select count(*)::int from information_schema.columns
         where table_schema = 'public' and table_name = 'sessions'
           and column_name in ('token', 'token_hash') and is_nullable = 'NO')
         as required_session_columns,
       (select count(*)::int from sessions
         where token <> token_hash
           or token !~ '^[a-f0-9]{64}$'
           or token_hash !~ '^[a-f0-9]{64}$') as invalid_session_rows,
       (select count(*)::int from information_schema.columns
         where table_schema = 'public' and table_name = 'competitor_suggestions'
           and column_name in ('channel_id','description','last_post_at','posts_per_week','on_topic'))
         as suggestion_columns,
       (select pg_get_constraintdef(oid)
          from pg_constraint
         where conrelid = 'autopilot_settings'::regclass
           and contype = 'p') as autopilot_settings_primary_key,
       (select to_regclass('autopilot_settings_user_channel_uniq') is not null)
         as autopilot_settings_rollback_index`,
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
    || Number(summary.invalidated_dual_sessions) !== 1
    || Number(summary.required_session_columns) !== 2
    || Number(summary.invalid_session_rows) !== 0
    || Number(summary.suggestion_columns) !== 5
    || summary.autopilot_settings_primary_key !== "PRIMARY KEY (project_id, channel_id)"
    || summary.autopilot_settings_rollback_index !== true
    || byId.get(101)?.external_message_id !== "77"
    || byId.get(102)?.external_message_id !== null
    || byId.get(102)?.result !== "duplicate_legacy_external_id"
    || byId.get(103)?.external_message_id !== "77"
  ) {
    throw new Error(`migration integration assertions failed: ${JSON.stringify({ posts: posts.rows, summary })}`);
  }

  // The previous release names the legacy arbiter explicitly. A forward-schema
  // application rollback must keep this statement valid after the PK switch.
  const previousReleaseInsert = `insert into autopilot_settings (user_id, channel_id, generation_engine)
    select user_id, id, 'navy-deepseek-flash' from channels order by id limit 1
    on conflict (user_id, channel_id) do nothing`;
  await pool.query(previousReleaseInsert);
  await pool.query(previousReleaseInsert);
  const rollbackCompatibleSettings = Number((await pool.query(
    `select count(*)::int as n
       from autopilot_settings settings
       join channels channel on channel.id = settings.channel_id
      where settings.user_id = channel.user_id`,
  )).rows[0]?.n ?? 0);
  if (rollbackCompatibleSettings !== 1) {
    throw new Error(`previous release Autopilot insert is not rollback-compatible: ${rollbackCompatibleSettings}`);
  }

  // The previous release omits item_snapshot from its Today state UPSERT. A rollback
  // after the snapshot migration must still be able to move a completed item to snoozed;
  // the compatibility trigger clears the now-inactive snapshot before constraints run.
  const legacyTodayScope = (await pool.query(
    "select project_id, user_id from channels where id = 10",
  )).rows[0];
  if (!legacyTodayScope) throw new Error("legacy Today rollback fixture has no channel 10");
  const legacyTodayFingerprint = "e".repeat(64);
  await pool.query(
    `insert into today_item_states (
       project_id, channel_id, user_id, fingerprint, ranking_version,
       state, snoozed_until, item_snapshot
     ) values ($1, 10, $2, $3, 'today-ranking-v1', 'done', null, $4::jsonb)`,
    [
      legacyTodayScope.project_id,
      legacyTodayScope.user_id,
      legacyTodayFingerprint,
      JSON.stringify({ title: "Legacy rollback fixture" }),
    ],
  );
  await pool.query(
    `insert into today_item_states
       (project_id, channel_id, user_id, fingerprint, ranking_version, state, snoozed_until)
     values ($1, 10, $2, $3, 'today-ranking-v1', 'snoozed', now() + interval '1 day')
     on conflict (project_id, channel_id, user_id, fingerprint) do update
       set state = excluded.state, snoozed_until = excluded.snoozed_until,
           ranking_version = excluded.ranking_version,
           state_version = today_item_states.state_version + 1,
           updated_at = now()`,
    [legacyTodayScope.project_id, legacyTodayScope.user_id, legacyTodayFingerprint],
  );
  const legacyTodayState = (await pool.query(
    `select state, item_snapshot from today_item_states
      where project_id = $1 and channel_id = 10 and user_id = $2 and fingerprint = $3`,
    [legacyTodayScope.project_id, legacyTodayScope.user_id, legacyTodayFingerprint],
  )).rows[0];
  if (legacyTodayState?.state !== "snoozed" || legacyTodayState?.item_snapshot !== null) {
    throw new Error(`previous release Today UPSERT is not rollback-compatible: ${JSON.stringify(legacyTodayState)}`);
  }

  const auditQuery = productionLedgerAudit.match(/\n(with relevant_ledger[\s\S]+?)\n\ncommit;/u)?.[1];
  if (!auditQuery) throw new Error("production ledger audit query could not be extracted");
  const auditClient = await pool.connect();
  let ledgerEvidence;
  try {
    await auditClient.query("begin transaction isolation level repeatable read read only");
    const result = await auditClient.query(auditQuery);
    ledgerEvidence = JSON.parse(String(result.rows[0]?.jsonb_build_object || "null"));
    await auditClient.query("commit");
  } catch (error) {
    await auditClient.query("rollback").catch(() => {});
    throw error;
  } finally {
    auditClient.release();
  }
  const auditedSessionMigration = ledgerEvidence?.ledger?.find(
    (entry) => entry.name === "20260916_session_token_hashes.sql",
  );
  if (
    ledgerEvidence?.transactionReadOnly !== "on"
    || auditedSessionMigration?.checksum !== "434acde2cee9f9a90112e5ed6083c0438a64bc596e6ffdbf8a0ff4c173adfc2c"
    || ledgerEvidence?.sessionColumns?.length !== 2
    || Number(ledgerEvidence?.sessionRows?.non_hash_token_rows) !== 0
    || Number(ledgerEvidence?.sessionRows?.non_hash_token_hash_rows) !== 0
    || Number(ledgerEvidence?.sessionRows?.divergent_dual_rows) !== 0
    || Number(ledgerEvidence?.sessionRows?.non_invalidated_pre_migration_rows) !== 0
  ) {
    throw new Error(`production ledger audit evidence is invalid: ${JSON.stringify(ledgerEvidence)}`);
  }

  const assertSessionCompatibility = async (expectedLedgerChecksum) => {
    const state = (await pool.query(
      `select
         (select checksum from schema_migrations
           where name = '20260916_session_token_hashes.sql') as checksum,
         (select count(*)::int from information_schema.columns
           where table_schema = 'public' and table_name = 'sessions'
             and column_name in ('token','token_hash') and is_nullable = 'NO') as required_columns,
         (select count(*)::int from sessions
           where token is null or token_hash is null or token <> token_hash
             or token !~ '^[a-f0-9]{64}$' or expires_at > now()) as invalid_rows`,
    )).rows[0];
    if (
      state?.checksum !== expectedLedgerChecksum
      || Number(state?.required_columns) !== 2
      || Number(state?.invalid_rows) !== 0
    ) throw new Error(`session history reconciliation failed: ${JSON.stringify(state)}`);

    const currentHash = "a".repeat(64);
    const legacyHash = "b".repeat(64);
    await pool.query(
      `insert into sessions (token_hash, user_id, expires_at, device, credential_epoch)
       values ($1, 1, now() + interval '1 hour', 'current-release', 1)`,
      [currentHash],
    );
    await pool.query(
      `insert into sessions (token, user_id, expires_at, device, credential_epoch)
       values ($1, 1, now() + interval '1 hour', 'previous-release', 1)`,
      [legacyHash],
    );
    const writes = (await pool.query(
      `select token, token_hash from sessions where token in ($1, $2) order by token`,
      [currentHash, legacyHash],
    )).rows;
    if (writes.length !== 2 || writes.some((row) => row.token !== row.token_hash)) {
      throw new Error(`session dual-write compatibility failed: ${JSON.stringify(writes)}`);
    }
  };

  // Historical ledger state #1: the original checksum left the hashed column named
  // `token`. It is accepted only after the runner proves the exact schema/data effect.
  await resetPublic();
  await pool.query(fixture);
  await pool.query(originalSessionMigration);
  await pool.query(`create table schema_migrations (
    name text primary key, checksum char(64) not null, applied_at timestamptz not null default now()
  )`);
  await pool.query(
    "insert into schema_migrations (name, checksum) values ($1, $2)",
    ["20260916_session_token_hashes.sql", "30c7987f372e4259b23fdc2d8bbee7257009b92e85385828741807c3c6f814ec"],
  );
  await pool.query(
    `insert into sessions (token, user_id, expires_at, device, created_at)
     select $1, 1, applied_at + interval '1 hour', 'post-history-active',
            applied_at + interval '1 second'
       from schema_migrations
      where name = '20260916_session_token_hashes.sql'`,
    ["c".repeat(64)],
  );
  await migrate({ env, logger: { log() {} } });
  await migrate({ env, logger: { log() {} } });
  await assertSessionCompatibility("30c7987f372e4259b23fdc2d8bbee7257009b92e85385828741807c3c6f814ec");

  // Historical ledger state #2: the renamed `token_hash` checksum converges to the
  // same dual-column expand boundary and remains compatible with the previous release.
  await resetPublic();
  await pool.query(fixture);
  await pool.query(currentSessionMigration);
  await pool.query(`create table schema_migrations (
    name text primary key, checksum char(64) not null, applied_at timestamptz not null default now()
  )`);
  await pool.query(
    "insert into schema_migrations (name, checksum) values ($1, $2)",
    ["20260916_session_token_hashes.sql", "434acde2cee9f9a90112e5ed6083c0438a64bc596e6ffdbf8a0ff4c173adfc2c"],
  );
  await migrate({ env, logger: { log() {} } });
  await migrate({ env, logger: { log() {} } });
  await assertSessionCompatibility("434acde2cee9f9a90112e5ed6083c0438a64bc596e6ffdbf8a0ff4c173adfc2c");

  // Any third checksum is rejected before earlier pending migrations can advance.
  await resetPublic();
  await pool.query(fixture);
  await pool.query(originalSessionMigration);
  await pool.query(`create table schema_migrations (
    name text primary key, checksum char(64) not null, applied_at timestamptz not null default now()
  )`);
  await pool.query(
    "insert into schema_migrations (name, checksum) values ($1, $2)",
    ["20260916_session_token_hashes.sql", "f".repeat(64)],
  );
  await migrate({ env, logger: { log() {} } })
    .then(() => { throw new Error("unknown session checksum unexpectedly succeeded"); })
    .catch((error) => {
      if (!String(error?.message || "").includes("checksum changed after application")) throw error;
    });
  const unknownState = (await pool.query(
    `select count(*)::int as ledger_rows,
            exists (
              select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'sessions' and column_name = 'token_hash'
            ) as token_hash_added
       from schema_migrations`,
  )).rows[0];
  if (Number(unknownState?.ledger_rows) !== 1 || unknownState?.token_hash_added !== false) {
    throw new Error(`unknown checksum was not fail-closed: ${JSON.stringify(unknownState)}`);
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

  const repairedSchema = (await pool.query(
    `select
       exists (
         select 1 from information_schema.columns
          where table_schema = 'public'
            and table_name = 'monthly_campaign_regeneration_targets'
            and column_name = 'item_regeneration_version'
            and is_nullable = 'NO'
       ) as regeneration_version_ready,
       exists (
         select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'publication_review_tasks'
            and column_name = 'version' and is_nullable = 'NO'
            and column_default = '1'::text
       ) as review_version_ready,
       exists (
         select 1 from pg_constraint
          where conrelid = 'autopilot_plan'::regclass
            and conname = 'autopilot_plan_approval_operation_project_fk'
       ) as approval_project_fk_ready,
       exists (
         select 1 from pg_constraint
          where conrelid = 'publication_review_tasks'::regclass
            and conname = 'publication_review_tasks_version_check'
       ) as review_version_check_ready,
       not exists (
         select 1 from pg_constraint
          where conrelid = 'publication_extra_operations'::regclass
            and conname = 'publication_extra_operations_project_id_post_id_sequence_in_key'
       ) as sequence_constraint_removed`,
  )).rows[0];
  if (!Object.values(repairedSchema).every(Boolean)) {
    throw new Error(`post-apply migration repairs are incomplete: ${JSON.stringify(repairedSchema)}`);
  }

  // A partially-managed installation may already have a nullable version column.
  // Re-run only the repair body against that shape and prove the backfill/default/
  // constraint converge without rewriting migration history.
  await pool.query("alter table publication_review_tasks alter column version drop not null");
  await pool.query("alter table publication_review_tasks alter column version drop default");
  await pool.query("alter table publication_review_tasks drop constraint publication_review_tasks_version_check");
  const repairName = "20260827_post_apply_migration_repairs.sql";
  const repairSql = await readFile(resolve("db/migrations", repairName), "utf8");
  await pool.query(repairSql);
  const partialRepair = (await pool.query(
    `select c.is_nullable, c.column_default,
            exists (
              select 1 from pg_constraint
               where conrelid = 'publication_review_tasks'::regclass
                 and conname = 'publication_review_tasks_version_check'
            ) as version_check
       from information_schema.columns c
      where c.table_schema = 'public' and c.table_name = 'publication_review_tasks'
        and c.column_name = 'version'`,
  )).rows[0];
  if (
    partialRepair?.is_nullable !== "NO"
    || partialRepair?.column_default !== "1"
    || partialRepair?.version_check !== true
  ) {
    throw new Error(`partial repair did not converge: ${JSON.stringify(partialRepair)}`);
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
