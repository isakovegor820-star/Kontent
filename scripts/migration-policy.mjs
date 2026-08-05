const MIGRATION_NAME_PATTERN = /^\d{8}_[a-z0-9_]+\.sql$/u;

const DESTRUCTIVE_STATEMENTS = [
  { label: "DROP TABLE", pattern: /\bdrop\s+table\b/iu },
  { label: "DROP COLUMN", pattern: /\bdrop\s+column\b/iu },
  { label: "TRUNCATE", pattern: /\btruncate(?:\s+table)?\b/iu },
  { label: "DELETE FROM", pattern: /\bdelete\s+from\b/iu },
];

const APPROVED_REPLACED_CONSTRAINTS = new Set([
  "ai_usage_status_check",
  "ai_usage_reservation_fields_check",
  "hashtag_sets_user_id_name_key",
  "posts_status_check",
  "posts_verification_state_check",
  "posts_publication_origin_check",
  "posts_schedule_revision_check",
  "autopilot_plan_revision_check",
  "content_brief_source_check",
  "rss_items_skip_reason_check",
]);

function withoutSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/--[^\r\n]*/gu, " ");
}

export function migrationBody(sql) {
  const source = String(sql);
  const start = source.match(/^\s*(?:(?:--[^\n]*(?:\n|$))\s*)*begin\s*;/iu);
  const end = /commit\s*;\s*$/iu.exec(source);
  if (!start || !end || end.index <= start[0].length) {
    throw new Error("migration must be enclosed by BEGIN/COMMIT");
  }
  return source.slice(start[0].length, end.index).trim();
}

export function validateMigrationSet(migrations) {
  const failures = [];
  if (!Array.isArray(migrations) || migrations.length === 0) {
    return ["db/migrations contains no SQL migrations"];
  }

  const seen = new Set();
  for (const migration of migrations) {
    const name = String(migration?.name || "");
    const sql = String(migration?.sql || "");

    if (!MIGRATION_NAME_PATTERN.test(name)) {
      failures.push(`${name || "<unnamed>"}: expected YYYYMMDD_snake_case.sql`);
    }
    if (seen.has(name)) failures.push(`${name}: duplicate migration filename`);
    seen.add(name);

    try {
      const body = withoutSqlComments(migrationBody(sql));
      if (/\b(?:commit|rollback|start\s+transaction)\b|\bbegin\s*;/iu.test(body)) {
        failures.push(
          `${name || "<unnamed>"}: transaction control is only allowed in the outer BEGIN/COMMIT envelope`,
        );
      }
    } catch {
      failures.push(`${name || "<unnamed>"}: migration must be enclosed by BEGIN/COMMIT`);
    }

    const executableSql = withoutSqlComments(sql);
    for (const statement of DESTRUCTIVE_STATEMENTS) {
      if (statement.pattern.test(executableSql)) {
        failures.push(
          `${name || "<unnamed>"}: ${statement.label} requires a separate approved migration path`,
        );
        break;
      }
    }

    const droppedConstraints = executableSql.matchAll(
      /\bdrop\s+constraint\s+(if\s+exists\s+)?"?([a-z0-9_]+)"?/giu,
    );
    for (const match of droppedConstraints) {
      const hasGuard = Boolean(match[1]);
      const constraint = String(match[2] || "").toLowerCase();
      if (!hasGuard || !APPROVED_REPLACED_CONSTRAINTS.has(constraint)) {
        failures.push(
          `${name || "<unnamed>"}: DROP CONSTRAINT ${constraint || "<unknown>"} is not allowlisted`,
        );
      }
    }
  }
  return failures;
}

export class MigrationPolicyError extends Error {
  constructor(failures) {
    super(`migration policy rejected the migration set:\n${failures.map((item) => `- ${item}`).join("\n")}`);
    this.name = "MigrationPolicyError";
    this.failures = [...failures];
  }
}

export function prepareMigrationSet(migrations) {
  const failures = validateMigrationSet(migrations);
  if (failures.length > 0) throw new MigrationPolicyError(failures);
  return migrations.map((migration) => ({
    name: String(migration.name),
    sql: String(migration.sql),
    body: migrationBody(migration.sql),
  }));
}
