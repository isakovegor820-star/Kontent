import { SCHEMA_MANIFEST } from "./schema-manifest.mjs";

const asSet = (values) => new Set((values || []).map((value) => String(value)));

/** Pure comparison used by unit tests and by the database-backed probe. */
export function evaluateSchemaSnapshot(snapshot, manifest = SCHEMA_MANIFEST) {
  const reasons = [];
  const applied = new Map(
    (snapshot.migrations || []).map((migration) => [
      String(migration.name),
      String(migration.checksum || "").trim(),
    ]),
  );
  const expectedNames = new Set(manifest.migrations.map((migration) => migration.name));

  if (!snapshot.schemaMigrationsTable) reasons.push("schema_migrations_table_missing");
  for (const migration of manifest.migrations) {
    const checksum = applied.get(migration.name);
    if (checksum === undefined) reasons.push(`migration_missing:${migration.name}`);
    else if (checksum !== migration.checksum) {
      reasons.push(`migration_checksum_mismatch:${migration.name}`);
    }
  }
  for (const name of [...applied.keys()].sort()) {
    if (!expectedNames.has(name)) reasons.push(`migration_unexpected:${name}`);
  }

  for (const [kind, expectedValues] of Object.entries(manifest.capabilities)) {
    const present = asSet(snapshot[kind]);
    for (const capability of expectedValues) {
      if (!present.has(capability)) reasons.push(`capability_missing:${kind.slice(0, -1)}:${capability}`);
    }
  }

  return {
    ready: reasons.length === 0,
    expectedVersion: manifest.schemaVersion,
    actualVersion: reasons.length === 0 ? manifest.schemaVersion : null,
    appliedMigrations: applied.size,
    expectedMigrations: manifest.migrations.length,
    reasons,
  };
}

/** Read only PostgreSQL catalogs. It never creates a table or runs a migration. */
export async function probeSchemaCompatibility(client, manifest = SCHEMA_MANIFEST) {
  const migrationTableResult = await client.query(
    "select to_regclass('public.schema_migrations') is not null as present",
  );
  const schemaMigrationsTable = migrationTableResult.rows[0]?.present === true;

  const [migrations, tables, columns, constraints, indexes] = await Promise.all([
    schemaMigrationsTable
      ? client.query("select name, checksum from schema_migrations order by name")
      : Promise.resolve({ rows: [] }),
    client.query(
      `select table_name as name
         from information_schema.tables
        where table_schema = 'public'`,
    ),
    client.query(
      `select table_name || '.' || column_name as name
         from information_schema.columns
        where table_schema = 'public'`,
    ),
    client.query(
      `select cls.relname || '.' || con.conname as name
         from pg_constraint con
         join pg_class cls on cls.oid = con.conrelid
         join pg_namespace ns on ns.oid = cls.relnamespace
        where ns.nspname = 'public'`,
    ),
    client.query(
      `select tablename || '.' || indexname as name
         from pg_indexes
        where schemaname = 'public'`,
    ),
  ]);

  return evaluateSchemaSnapshot({
    schemaMigrationsTable,
    migrations: migrations.rows,
    tables: tables.rows.map((row) => row.name),
    columns: columns.rows.map((row) => row.name),
    constraints: constraints.rows.map((row) => row.name),
    indexes: indexes.rows.map((row) => row.name),
  }, manifest);
}

