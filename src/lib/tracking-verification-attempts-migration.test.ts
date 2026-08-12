import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../../db/migrations/20260824_tracking_verification_and_attempt_journals.sql",
  import.meta.url,
);
const schemaUrl = new URL("../../db/schema.sql", import.meta.url);

describe("tracking verification and durable attempt journals migration", () => {
  it("is transactional and demotes origin-only tracking until an exact challenge is verified", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.trimStart().toLowerCase()).toMatch(/^begin;/u);
    expect(sql.trimEnd().toLowerCase()).toMatch(/commit;$/u);
    expect(sql).toContain("verification_challenge varchar(160)");
    expect(sql).toContain("status = case when status = 'active' then 'pending_verification'");
    expect(sql.indexOf("drop constraint if exists project_tracking_settings_status_check"))
      .toBeLessThan(sql.indexOf("update project_tracking_settings"));
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("verification_checked_at is not null");
    expect(sql).toContain("verified_at is not null");
  });

  it.each([
    ["legal_visual_render_attempts", "legal_visual_render_operations"],
    ["publication_extra_attempts", "publication_extra_operations"],
  ])("creates project-bound, one-row-per-attempt safe journal %s", async (table, operationTable) => {
    const sql = await readFile(migrationUrl, "utf8");
    const start = sql.indexOf(`create table if not exists ${table}`);
    const end = sql.indexOf("create index", start);
    const definition = sql.slice(start, end);
    expect(start).toBeGreaterThan(0);
    expect(definition).toContain(`references ${operationTable} (id, project_id) on delete cascade`);
    expect(definition).toContain("unique (operation_id, attempt_number)");
    expect(definition).toContain("status in ('running','succeeded','failed_retry','failed')");
    expect(definition).toContain("safe_error_code varchar(100)");
    expect(definition).toContain("started_at");
    expect(definition).toContain("completed_at");
    expect(definition).not.toMatch(/\b(error_message|payload|request_body|response_body|token|ip_address|user_agent)\b/iu);
  });

  it("keeps the bootstrap schema aligned with both journals and verification fields", async () => {
    const schema = await readFile(schemaUrl, "utf8");
    for (const fragment of [
      "create table if not exists legal_visual_render_attempts",
      "create table if not exists publication_extra_attempts",
      "verification_challenge varchar(160)",
      "verification_checked_at timestamptz",
      "verification_error_code varchar(100)",
    ]) expect(schema).toContain(fragment);
  });
});
