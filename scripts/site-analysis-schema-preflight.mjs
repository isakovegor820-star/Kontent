import { SCHEMA_MANIFEST } from "../src/lib/schema-manifest.mjs";
import { RuntimeSchemaPreflightError } from "./runtime-schema-preflight.mjs";

const SITE_ANALYSIS_MIGRATIONS = new Set([
  "20260801_ai_usage_reservations.sql",
  "20260805_site_analysis.sql",
  "20260805_site_analysis_osint.sql",
]);

const belongsToSiteAnalysis = (value) => (
  String(value).startsWith("site_analysis_")
  || String(value) === "ai_usage"
  || String(value).startsWith("ai_usage.")
);

const expectedMigrations = SCHEMA_MANIFEST.migrations.filter((migration) => (
  SITE_ANALYSIS_MIGRATIONS.has(migration.name)
));

const expectedCapabilities = Object.freeze({
  tables: Object.freeze([
    "ai_usage",
    ...SCHEMA_MANIFEST.capabilities.tables.filter(belongsToSiteAnalysis),
  ]),
  columns: Object.freeze(SCHEMA_MANIFEST.capabilities.columns.filter(belongsToSiteAnalysis)),
  constraints: Object.freeze(SCHEMA_MANIFEST.capabilities.constraints.filter(belongsToSiteAnalysis)),
  indexes: Object.freeze(SCHEMA_MANIFEST.capabilities.indexes.filter(belongsToSiteAnalysis)),
});

const rowSet = (result) => new Set(result.rows.map((row) => String(row.name)));

/** Read-only preflight for the isolated site-analysis worker. */
export async function assertSiteAnalysisSchemaReady(client) {
  try {
    const migrationTable = await client.query(
      "select to_regclass('public.schema_migrations') is not null as present",
    );
    if (migrationTable.rows[0]?.present !== true) {
      throw new RuntimeSchemaPreflightError("schema_incompatible", ["schema_migrations_table_missing"]);
    }

    const migrations = await client.query("select name, checksum from schema_migrations");
    const applied = new Map(migrations.rows.map((row) => [String(row.name), String(row.checksum)]));
    const reasons = [];
    for (const migration of expectedMigrations) {
      const checksum = applied.get(migration.name);
      if (checksum === undefined) reasons.push(`migration_missing:${migration.name}`);
      else if (checksum !== migration.checksum) reasons.push(`migration_checksum_mismatch:${migration.name}`);
    }

    const tables = rowSet(await client.query(
      "select table_name as name from information_schema.tables where table_schema = 'public'",
    ));
    const columns = rowSet(await client.query(
      "select table_name || '.' || column_name as name from information_schema.columns where table_schema = 'public'",
    ));
    const constraints = rowSet(await client.query(
      `select cls.relname || '.' || con.conname as name
         from pg_constraint con
         join pg_class cls on cls.oid = con.conrelid
         join pg_namespace ns on ns.oid = cls.relnamespace
        where ns.nspname = 'public'`,
    ));
    const indexes = rowSet(await client.query(
      "select tablename || '.' || indexname as name from pg_indexes where schemaname = 'public'",
    ));

    for (const [kind, expected] of Object.entries(expectedCapabilities)) {
      const present = { tables, columns, constraints, indexes }[kind];
      for (const capability of expected) {
        if (!present.has(capability)) reasons.push(`capability_missing:${kind.slice(0, -1)}:${capability}`);
      }
    }

    if (reasons.length) throw new RuntimeSchemaPreflightError("schema_incompatible", reasons);
    return { ready: true, migrations: expectedMigrations.length };
  } catch (error) {
    if (error instanceof RuntimeSchemaPreflightError) throw error;
    throw new RuntimeSchemaPreflightError("database_unreachable", [
      "schema_not_checked:database_unreachable",
    ]);
  }
}
