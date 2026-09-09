import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";

const databaseUrl = process.env.DIAGNOSTICS_PRIVACY_TEST_DATABASE_URL || "";
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || !["postgres:", "postgresql:"].includes(target.protocol)
  || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
  || !["/aurora_diagnostics_privacy_test", "/aurora_q03_diagnostics_privacy_test"].includes(target.pathname)) {
  throw new Error("Requires explicit disposable loopback DIAGNOSTICS_PRIVACY_TEST_DATABASE_URL");
}
const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const users: number[] = [];
const reportSql = await readFile(new URL("../../scripts/production-autopilot-diagnostics.sql", import.meta.url), "utf8");

beforeAll(async () => {
  expect(Number((await pool.query("select count(*) from pg_tables where schemaname='public'")).rows[0].count)).toBe(0);
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { DATABASE_URL: databaseUrl }, logger: { log() {} } });
}, 60_000);
afterAll(async () => {
  try { for (const id of users) await pool.query("delete from users where id=$1", [id]); }
  finally { await pool.end(); }
});

async function fixture(rules: string, privateValue: string, item: Record<string, unknown> = {}) {
  const user = Number((await pool.query("insert into users(email,name) values($1,'Diagnostics synthetic owner') returning id", [`diagnostics-${randomUUID()}@example.test`])).rows[0].id);
  users.push(user);
  const project = Number((await pool.query("insert into projects(name,created_by_user_id) values('Diagnostics fixture',$1) returning id", [user])).rows[0].id);
  await pool.query("insert into project_members(project_id,user_id,role,status) values($1,$2,'owner','active')", [project, user]);
  const channel = Number((await pool.query("insert into channels(user_id,project_id,network,title,is_active,status) values($1,$2,'tg','Synthetic channel',false,'disconnected') returning id", [user, project])).rows[0].id);
  await pool.query("insert into autopilot_settings(user_id,project_id,channel_id,quick_settings) values($1,$2,$3,$4)", [user, project, channel, { editorial: privateValue }]);
  const plan = Number((await pool.query(`insert into autopilot_plan(user_id,project_id,channel_id,week_start,status,rules,build_report,quick_settings,items,terminal_outcome)
    values($1,$2,$3,current_date,'partial',$4,$5,$6,$7,'partial') returning id`, [user, project, channel, rules,
    { customerContext: privateValue, autoRecovery: { jobId: privateValue } }, { privateContext: privateValue }, JSON.stringify([item]),
  ])).rows[0].id);
  return { user, project, channel, plan };
}

async function report() {
  // Only psql presentation commands are removed. The actual BEGIN READ ONLY,
  // complete report SELECT, and COMMIT execute unchanged on a fresh connection.
  const client = await pool.connect();
  try {
    const result = await client.query(reportSql.replace(/^\\.*$/gm, ""));
    const results = Array.isArray(result) ? result : [result];
    const raw = String(results.find(entry => entry.rows?.[0]?.jsonb_pretty)?.rows[0].jsonb_pretty);
    const parsed = JSON.parse(raw);
    expect(parsed.transactionReadOnly).toBe("on");
    return { raw, parsed };
  } finally { await client.query("rollback"); client.release(); }
}

describe.sequential("whole production SQL export privacy with synthetic data", () => {
  it.each(["PRIVATE_EDITORIAL_FIXTURE", "privateclientmatter"])("does not export editorial prose including code-shaped lowercase text: %s", async (canary) => {
    await fixture(canary, canary);
    const { raw } = await report();
    // Boolean assertion avoids printing the report/canary-bearing database row on failure.
    expect(raw.includes(canary)).toBe(false);
  });

  it("does not export arbitrary JSON-derived job IDs or any item diagnostic scalar", async () => {
    const canary = "privatejsondiagnosticvalue";
    await fixture("provider_error", canary, {
      topic: canary, draft: canary, buildState: canary, reviewState: canary, reviewReason: canary,
      _providerFailure: { code: canary, engine: canary },
      quality: {
        publicationDisposition: canary,
        metadata: { provenance: { validator: canary, trigger: canary }, rules: { version: canary } },
        semantic: { status: canary, version: canary, passed: canary, requiresReview: canary,
          provenance: { provider: canary, validatorVersion: canary, terminalVerdict: canary },
          claimVerdicts: [{ verdict: canary, reasonCode: canary }],
        },
        violations: [{ code: canary, blocker: true }, { code: canary, blocker: false }],
      },
    });
    expect((await report()).raw.includes(canary)).toBe(false);
  });

  it("retains known machine failure codes, constrained states, counts and read-only execution", async () => {
    const ids = await fixture("provider_error", "safe-fixture-private-value", {
      draft: "synthetic text", aiReady: true, reviewRequired: true, buildState: "ready",
      _providerFailure: { code: "provider_error", engine: "navy-deepseek-pro" },
      quality: { passed: true, publicationDisposition: "confirmation_required", blockers: [],
        violations: [{ code: "too_short", blocker: true }],
        metadata: { provenance: { validator: "validatePostQuality", trigger: "generation" }, rules: { version: 1 } },
        semantic: { status: "not_checked", version: 1, passed: false, requiresReview: true, claimVerdicts: [] },
      },
    });
    const { raw, parsed } = await report();
    const plan = parsed.recentPlans.find((row: { id: string }) => Number(row.id) === ids.plan);
    expect(plan).toMatchObject({ status: "partial", item_count: 1 });
    expect(raw.includes("provider_error")).toBe(true);
    expect(parsed.planItemVerdicts[0]).toMatchObject({ ai_ready: true, quality_passed: true, review_required: true, semantic_claim_count: 0, build_state: "ready", disposition: "confirmation_required", provider_failure_code: "provider_error", provider_failure_engine: "navy-deepseek-pro", quality_validator: "validatePostQuality", quality_trigger: "generation", quality_rules_version: "1", semantic_status: "not_checked", semantic_version: "1", semantic_passed: false, semantic_requires_review: true, blocker_codes: "too_short" });
    expect((await pool.query("select rules,items from autopilot_plan where id=$1", [ids.plan])).rows[0]).toMatchObject({ rules: "provider_error", items: [expect.objectContaining({ draft: "synthetic text" })] });
  });
  it("never exports unconstrained AI usage kinds or treats successful editorial rules as error codes", async () => {
    const canary = "privateusagekind";
    const ids = await fixture("provider_error", "private-success-context");
    await pool.query("insert into ai_usage(user_id,kind) values($1,$2)", [ids.user, canary]);
    await pool.query("update autopilot_plan set status='pending' where id=$1", [ids.plan]);
    const { raw, parsed } = await report();
    expect(raw.includes(canary)).toBe(false);
    expect(parsed.recentPlans.find((row: { id: string }) => Number(row.id) === ids.plan).rules_code).toBeNull();
    expect(parsed.recoveryVisibility.every((row: Record<string, unknown>) => !Object.hasOwn(row, "auto_recovery_job_id"))).toBe(true);
  });

});
