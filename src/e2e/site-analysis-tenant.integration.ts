import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { migrate } from "../../scripts/migrate.mjs";

const mocks = vi.hoisted(() => ({ getPool: vi.fn(), getSessionUser: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));

import { GET as getAnalysis } from "@/app/api/site-analysis/[id]/route";
import { GET as listAnalyses } from "@/app/api/site-analysis/route";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
  || target.pathname.slice(1) !== "aurora_publication_gate_test") {
  throw new Error("Site-analysis tenant integration requires disposable local aurora_publication_gate_test database");
}

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 4 });
let userId = 0;
let memberBId = 0;
let projectA = 0;
let projectB = 0;
let analysisA = 0;
let analysisB = 0;

async function selectProject(actorUserId: number, projectId: number) {
  await pool.query(
    `insert into user_project_preferences (user_id, selected_project_id)
     values ($1, $2)
     on conflict (user_id) do update set selected_project_id = excluded.selected_project_id`,
    [actorUserId, projectId],
  );
}

async function listFor(actorUserId: number) {
  mocks.getSessionUser.mockResolvedValueOnce({ id: actorUserId, email: `user-${actorUserId}@example.test` });
  const response = await listAnalyses(new NextRequest("http://localhost/api/site-analysis"));
  return { response, body: await response.json() };
}

beforeAll(async () => {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
  mocks.getPool.mockReturnValue(pool);

  const users = await pool.query<{ id: string }>(
    `insert into users (email, name)
     values ('tenant-owner@example.test', 'Tenant owner'),
            ('tenant-member-b@example.test', 'Tenant member B') returning id`,
  );
  [userId, memberBId] = users.rows.map((row) => Number(row.id));
  const projects = await pool.query<{ id: string }>(
    `insert into projects (name, timezone, created_by_user_id)
     values ('Project A', 'UTC', $1), ('Project B', 'UTC', $1) returning id`,
    [userId],
  );
  [projectA, projectB] = projects.rows.map((row) => Number(row.id));
  await pool.query(
    `insert into project_members (project_id, user_id, role, status)
     values ($1, $3, 'owner', 'active'), ($2, $3, 'owner', 'active'),
            ($2, $4, 'author', 'active')`,
    [projectA, projectB, userId, memberBId],
  );
  await selectProject(userId, projectA);
  await selectProject(memberBId, projectB);

  const inserted = await pool.query<{ id: string; project_id: string | null }>(
    `insert into site_analysis_jobs (
       project_id, user_id, request_id, idempotency_key, request_fingerprint,
       target_url, confirmed_domain, consented_at, status, stage, progress
     ) values
       ($1, $3, 'request-a', $4, 'fingerprint-a', 'https://a.example/', 'a.example', now(), 'ready', 'ready', 100),
       ($2, $3, 'request-b', $5, 'fingerprint-b', 'https://b.example/', 'b.example', now(), 'ready', 'ready', 100),
       (null, $3, 'request-legacy', 'legacy-unscoped', 'fingerprint-legacy', 'https://legacy.example/', 'legacy.example', now(), 'ready', 'ready', 100)
     returning id, project_id`,
    [projectA, projectB, userId, `project:${projectA}:shared-key`, `project:${projectB}:shared-key`],
  );
  analysisA = Number(inserted.rows.find((row) => Number(row.project_id) === projectA)?.id);
  analysisB = Number(inserted.rows.find((row) => Number(row.project_id) === projectB)?.id);
});

afterAll(async () => {
  await pool.end();
});

describe.sequential("site analysis project isolation", () => {
  it("changes the visible analysis set with the selected project and never exposes NULL legacy rows", async () => {
    const a = await listFor(userId);
    expect(a.response.status).toBe(200);
    expect(a.body.analyses.map((analysis: { id: number }) => analysis.id)).toEqual([analysisA]);

    await selectProject(userId, projectB);
    const b = await listFor(userId);
    expect(b.response.status).toBe(200);
    expect(b.body.analyses.map((analysis: { id: number }) => analysis.id)).toEqual([analysisB]);
  });

  it("does not let a project-B member fetch project A by id", async () => {
    mocks.getSessionUser.mockResolvedValueOnce({ id: memberBId, email: "tenant-member-b@example.test" });
    const response = await getAnalysis(
      new NextRequest(`http://localhost/api/site-analysis/${analysisA}`),
      { params: Promise.resolve({ id: String(analysisA) }) },
    );
    expect(response.status).toBe(404);
  });

  it("stores the same raw idempotency key independently in projects A and B", async () => {
    const rows = await pool.query(
      `select project_id, idempotency_key from site_analysis_jobs
        where user_id = $1 and idempotency_key like 'project:%:shared-key'
        order by project_id`,
      [userId],
    );
    expect(rows.rows).toEqual([
      { project_id: String(projectA), idempotency_key: `project:${projectA}:shared-key` },
      { project_id: String(projectB), idempotency_key: `project:${projectB}:shared-key` },
    ]);
  });
});
