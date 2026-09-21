import { randomUUID } from "node:crypto";

import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  loadAdminAuroraAnalytics,
  normalizeAdminAnalyticsQuery,
} from "@/lib/admin-aurora-analytics";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
  || target.pathname.slice(1) !== "aurora_migration_test") {
  throw new Error("Admin operations integration requires local aurora_migration_test");
}

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 1 });
let client: PoolClient;
let userId = 0;
let projectId = 0;
const now = new Date("2026-08-30T18:00:00.000Z");

async function insertEvent(input: {
  occurredAt: Date;
  sessionId?: string;
  action: string;
  stage: "started" | "accepted" | "queued" | "processing" | "completed" | "failed" | "retried" | "cancelled";
  outcome: "pending" | "success" | "failure" | "cancelled";
  durationMs?: number;
  errorCode?: string;
  operationId?: string;
}) {
  await client.query(
    `insert into product_events (
       event_id, project_id, user_id, section_id, feature_id, action, stage, outcome,
       duration_ms, error_code, request_id, operation_id, release_key, session_id,
       occurred_at, safe_context, important
     ) values (
       $1::uuid,$2,$3,'studio','generation',$4,$5,$6,$7,$8,'admin-ops-integration',$9,
       'ops-integration-release',$10::uuid,$11::timestamptz,$12::jsonb,$13
     )`,
    [
      randomUUID(), projectId, userId, input.action, input.stage, input.outcome,
      input.durationMs ?? null, input.errorCode ?? null, input.operationId ?? null,
      input.sessionId ?? null, input.occurredAt.toISOString(),
      JSON.stringify({ device: "desktop", source: input.stage === "processing" ? "worker" : "api", operationKind: "ai_generation", appVersion: "integration" }),
      input.outcome === "failure",
    ],
  );
}

beforeAll(async () => {
  client = await pool.connect();
  await client.query("begin");
  const migration = await client.query(
    "select checksum from schema_migrations where name = '20261005_admin_operations_center.sql'",
  );
  expect(migration.rows[0]?.checksum).toMatch(/^[0-9a-f]{64}$/u);
  userId = Number((await client.query(
    "insert into users (email, name) values ($1, 'Admin operations integration') returning id",
    [`admin-ops-${randomUUID()}@example.test`],
  )).rows[0]?.id);
  projectId = Number((await client.query(
    "insert into projects (name, created_by_user_id) values ('Admin operations integration', $1) returning id",
    [userId],
  )).rows[0]?.id);
  await client.query(
    "insert into project_members (project_id, user_id, role, status) values ($1,$2,'owner','active')",
    [projectId, userId],
  );
  await client.query(
    `insert into aurora_releases (release_key, commit_sha, deployed_at)
     values ('ops-integration-release','abcdef1',$1::timestamptz)`,
    [new Date(now.getTime() - 3_600_000).toISOString()],
  );
  const journeySession = randomUUID();
  await insertEvent({ occurredAt: new Date(now.getTime() - 120 * 60_000), sessionId: journeySession, action: "loaded", stage: "completed", outcome: "success", durationMs: 300 });
  await insertEvent({ occurredAt: new Date(now.getTime() - 119 * 60_000), sessionId: journeySession, action: "saved", stage: "completed", outcome: "success", durationMs: 900, operationId: "completed-operation" });
  await insertEvent({ occurredAt: new Date(now.getTime() - 70 * 60_000), action: "requested", stage: "processing", outcome: "pending", operationId: "stuck-operation" });
  await insertEvent({ occurredAt: new Date(now.getTime() - 30 * 60_000), action: "result_received", stage: "failed", outcome: "failure", durationMs: 1_800, errorCode: "provider_timeout", operationId: "failed-operation" });
  await insertEvent({ occurredAt: new Date(now.getTime() - 30 * 3_600_000), action: "result_received", stage: "failed", outcome: "failure", durationMs: 1_700, errorCode: "provider_timeout", operationId: "previous-failed-operation" });
});

afterAll(async () => {
  if (client) {
    await client.query("rollback").catch(() => undefined);
    client.release();
  }
  await pool.end();
});

describe.sequential("admin operations analytics SQL", () => {
  it("runs every fixed query against the migrated schema and correlates real event rows", async () => {
    const filters = normalizeAdminAnalyticsQuery(new URLSearchParams({
      range: "24h",
      project: String(projectId),
      analyticsSection: "studio",
      analyticsTab: "overview",
    }), now);
    // Pool queries are concurrent in production. A single transactional test client is
    // deliberately serialized so pg never receives overlapping client.query calls.
    let queryQueue: Promise<unknown> = Promise.resolve();
    const transactionalDb = {
      query(text: string, values?: readonly unknown[]) {
        const next = queryQueue.then(() => client.query(text, values as unknown[] | undefined));
        queryQueue = next.then(() => undefined, () => undefined);
        return next;
      },
    };
    const analytics = await loadAdminAuroraAnalytics(transactionalDb as never, filters, { now });
    const studio = analytics.sections.find((section) => section.id === "studio");

    expect(analytics.sections).toHaveLength(15);
    expect(studio?.activity.launches.current).toBe(1);
    expect(studio?.outcome.timeToResultP50Ms.current).toBe(60_000);
    expect(analytics.detail?.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ errorCode: "provider_timeout", affectedUsers: 1, affectedProjects: 1 }),
    ]));
    expect(analytics.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "stuck_stage", sectionId: "studio", frequency: 1 }),
    ]));
    expect(analytics.releases).toEqual(expect.arrayContaining([
      expect.objectContaining({ release: "ops-integration-release" }),
    ]));
  });
});
