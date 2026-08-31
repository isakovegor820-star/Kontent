import { SCHEMA_MANIFEST } from "./schema-manifest.mjs";

const asSet = (values) => new Set((values || []).map((value) => String(value)));

/**
 * A rollback reverts code but never un-applies a migration, so the release that a
 * rollback lands on always meets a database that is newer than its own manifest.
 * Treating that as fatal turned every rollback into a permanent worker outage: the
 * runtime gate exits, systemd restarts, the BullMQ consumer and the weekly Autopilot
 * cron never come up, and the platform stays down until someone rolls forward.
 *
 * Migrations are additive by enforced policy (see `scripts/migration-policy.mjs`: no
 * DROP TABLE/COLUMN, no TRUNCATE/DELETE, DROP CONSTRAINT only from an allowlist) and
 * are named with a sortable `YYYYMMDD_` prefix, so a migration sorting after everything
 * this build knows about can only be a newer release's additive schema. Accepting it
 * keeps the required-capability checks below as the real contract: anything this build
 * actually reads or writes must still exist.
 *
 * An unknown migration that sorts *before* the newest known one is not a newer release
 * — it is drift or a foreign writer, and stays fatal.
 */
function newestExpectedMigration(manifest) {
  return manifest.migrations.reduce(
    (newest, migration) => (migration.name > newest ? migration.name : newest),
    "",
  );
}

/** Pure comparison used by unit tests and by the database-backed probe. */
export function evaluateSchemaSnapshot(snapshot, manifest = SCHEMA_MANIFEST) {
  const reasons = [];
  const forwardMigrations = [];
  const applied = new Map(
    (snapshot.migrations || []).map((migration) => [
      String(migration.name),
      String(migration.checksum || "").trim(),
    ]),
  );
  const expectedNames = new Set(manifest.migrations.map((migration) => migration.name));
  const newestExpected = newestExpectedMigration(manifest);

  if (!snapshot.schemaMigrationsTable) reasons.push("schema_migrations_table_missing");
  for (const migration of manifest.migrations) {
    const checksum = applied.get(migration.name);
    if (checksum === undefined) reasons.push(`migration_missing:${migration.name}`);
    else if (
      checksum !== migration.checksum
      && !migration.acceptedChecksums?.includes(checksum)
    ) {
      reasons.push(`migration_checksum_mismatch:${migration.name}`);
    }
  }
  for (const name of [...applied.keys()].sort()) {
    if (expectedNames.has(name)) continue;
    if (name > newestExpected) forwardMigrations.push(name);
    else reasons.push(`migration_unexpected:${name}`);
  }

  for (const [kind, expectedValues] of Object.entries(manifest.capabilities)) {
    const present = asSet(snapshot[kind]);
    for (const capability of expectedValues) {
      if (!present.has(capability)) reasons.push(`capability_missing:${kind.slice(0, -1)}:${capability}`);
    }
  }

  const ready = reasons.length === 0;
  return {
    ready,
    expectedVersion: manifest.schemaVersion,
    actualVersion: ready ? manifest.schemaVersion : null,
    appliedMigrations: applied.size,
    expectedMigrations: manifest.migrations.length,
    forwardMigrations,
    // Surfaced so `/api/readiness` reports the drift an operator must still resolve by
    // rolling forward, without pretending the schema is identical to this build's.
    reasons: [...reasons, ...forwardMigrations.map((name) => `schema_forward:${name}`)],
  };
}

/** Read only PostgreSQL catalogs. It never creates a table or runs a migration. */
export async function probeSchemaCompatibility(client, manifest = SCHEMA_MANIFEST) {
  const migrationTableResult = await client.query(
    "select to_regclass('public.schema_migrations') is not null as present",
  );
  const schemaMigrationsTable = migrationTableResult.rows[0]?.present === true;

  // pg@9 removes support for overlapping query calls on one Client. Keep this probe
  // compatible (and warning-free in dev) by reading the catalogs sequentially.
  const migrations = schemaMigrationsTable
    ? await client.query("select name, checksum from schema_migrations order by name")
    : { rows: [] };
  const tables = await client.query(
    `select table_name as name
       from information_schema.tables
      where table_schema = 'public'`,
  );
  const columns = await client.query(
    `select table_name || '.' || column_name as name
       from information_schema.columns
      where table_schema = 'public'`,
  );
  const constraints = await client.query(
    `select cls.relname || '.' || con.conname as name
       from pg_constraint con
       join pg_class cls on cls.oid = con.conrelid
       join pg_namespace ns on ns.oid = cls.relnamespace
      where ns.nspname = 'public'`,
  );
  const indexes = await client.query(
    `select tablename || '.' || indexname as name
       from pg_indexes
      where schemaname = 'public'`,
  );

  return evaluateSchemaSnapshot({
    schemaMigrationsTable,
    migrations: migrations.rows,
    tables: tables.rows.map((row) => row.name),
    columns: columns.rows.map((row) => row.name),
    constraints: constraints.rows.map((row) => row.name),
    indexes: indexes.rows.map((row) => row.name),
  }, manifest);
}
