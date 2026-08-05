import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { validateMigrationSet } from "./migration-policy.mjs";
import { SCHEMA_MANIFEST } from "../src/lib/schema-manifest.mjs";

const root = resolve(process.cwd(), "db/migrations");
const names = (await readdir(root)).filter((name) => name.endsWith(".sql")).sort();
const migrations = await Promise.all(
  names.map(async (name) => ({ name, sql: await readFile(resolve(root, name), "utf8") })),
);
const failures = validateMigrationSet(migrations);
const expected = new Map(
  SCHEMA_MANIFEST.migrations.map((migration) => [migration.name, migration.checksum]),
);
for (const migration of migrations) {
  const checksum = createHash("sha256").update(migration.sql, "utf8").digest("hex");
  if (!expected.has(migration.name)) failures.push(`${migration.name}: missing from runtime schema manifest`);
  else if (expected.get(migration.name) !== checksum) {
    failures.push(`${migration.name}: runtime schema manifest checksum is stale`);
  }
}
for (const name of expected.keys()) {
  if (!names.includes(name)) failures.push(`${name}: schema manifest references a missing migration`);
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Validated ${names.length} additive transactional migrations.`);
}
