import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import pg from "pg";
import { NextRequest } from "next/server";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { cancelPublicationOperation, reschedulePublicationOperation } from "@/lib/publication-lifecycle.mjs";

const mocks = vi.hoisted(() => ({ pool: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: mocks.pool }));
vi.mock("@/lib/session", () => ({ getSessionUser: async (req: NextRequest) => ({ id: Number(req.headers.get("x-test-user")) }) }));
import { GET as postsGET } from "@/app/api/posts/route";
import { GET as draftsGET } from "@/app/api/drafts/route";
const target = new URL(String(process.env.DATABASE_URL));
if (target.hostname !== "127.0.0.1" || target.port !== "55437") throw new Error("Isolated local PostgreSQL required");
const admin = new pg.Pool({ connectionString: target.href, ssl: false });
const database = `aurora_calendar_${randomUUID().replaceAll("-", "")}`;
target.pathname = `/${database}`;
const pool = new pg.Pool({ connectionString: target.href, ssl: false, max: 8 });
let userId: number, projectId: number, foreignProject: number, channelId: number, futureId: number, futureDraft: number, operationId: number;
const queries: { sql: string; params: unknown[] }[] = [];
const windowQuery = "view=range&from=2030-04-01&to=2030-05-01";
function request(resource: "posts" | "drafts", query: string, project = projectId) {
  return new NextRequest(`http://localhost/api/${resource}?${query}`, { headers: { "x-test-user": String(userId), "x-aurora-project-id": String(project) } });
}
async function page(resource: "posts" | "drafts", query: string, project = projectId) {
  const response = await (resource === "posts" ? postsGET : draftsGET)(request(resource, query, project));
  expect(response.status).toBe(200);
  expect(response.headers.get("x-aurora-project-id")).toBe(String(project));
  return response.json();
}
async function all(resource: "posts" | "drafts", query: string) {
  const ids: number[] = []; let cursor: string | null = null;
  do {
    const params = new URLSearchParams(query);
    if (cursor) params.set("cursor", cursor);
    const body = await page(resource, params.toString());
    expect(typeof body.hasMore).toBe("boolean");
    ids.push(...body[resource].map((r: { id: number }) => r.id));
    cursor = body.nextCursor;
    expect(Boolean(cursor)).toBe(body.hasMore);
  } while (cursor);
  expect(new Set(ids).size).toBe(ids.length);
  return ids;
}
beforeAll(async () => {
  await admin.query(`create database ${database}`);
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  userId = Number((await pool.query("insert into users(email) values('calendar@example.test') returning id")).rows[0].id);
  [projectId, foreignProject] = (await pool.query("insert into projects(name,timezone,created_by_user_id) values('Calendar','Europe/Amsterdam',$1),('Other','UTC',$1) returning id", [userId])).rows.map(r => Number(r.id));
  await pool.query("insert into project_members(project_id,user_id,role) values($1,$3,'owner'),($2,$3,'owner')", [projectId, foreignProject, userId]);
  await pool.query("insert into user_project_preferences(user_id,selected_project_id) values($1,$2)", [userId,projectId]);
  channelId = Number((await pool.query("insert into channels(user_id,project_id,network,title,tg_chat_id,is_active) values($1,$2,'tg','Calendar',-10091230000,true) returning id", [userId,projectId])).rows[0].id);
  await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at) select $1,$2,$3,'Historical '||n,'published','2020-01-01'::timestamptz+n*interval '1 minute' from generate_series(1,12000)n", [userId,projectId,channelId]);
  futureDraft = Number((await pool.query("insert into drafts(user_id,project_id,text,client_key,scheduled_at) values($1,$2,'Future draft','future','2030-04-10T10:00:00Z') returning id", [userId,projectId])).rows[0].id);
  await pool.query("insert into drafts(user_id,project_id,text,client_key,scheduled_at) select $1,$2,'Historical draft '||n,'history-'||n,'2020-01-01'::timestamptz+n*interval '1 minute' from generate_series(1,12000)n", [userId,projectId]);
  operationId = Number((await pool.query("insert into publication_operations(project_id,user_id,draft_version,idempotency_key,fingerprint,text,scheduled_at,timezone,destination_ids,status) values($1,$2,1,'future-operation',$3,'Future post','2030-04-10T10:00:00Z','Europe/Amsterdam',$4::jsonb,'queued') returning id", [projectId,userId,'f'.repeat(64),JSON.stringify([channelId])])).rows[0].id);
  futureId = Number((await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at,publication_operation_id) values($1,$2,$3,'Future post','scheduled','2030-04-10T10:00:00Z',$4) returning id", [userId,projectId,channelId,operationId])).rows[0].id);
  await pool.query("insert into publication_outbox(operation_id,post_id) values($1,$2)", [operationId,futureId]);
  for (const resource of ["posts", "drafts"] as const) {
    if (resource === "posts") await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at) select $1,$2,$3,'April '||n,'scheduled','2030-04-15T10:00:00Z' from generate_series(1,420)n", [userId,projectId,channelId]);
    else await pool.query("insert into drafts(user_id,project_id,text,client_key,scheduled_at) select $1,$2,'April draft '||n,'april-'||n,'2030-04-15T10:00:00Z' from generate_series(1,420)n", [userId,projectId]);
  }
  await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at) values($1,$2,$3,'Undated','draft',null),($1,$2,$3,'Old failure','failed','2020-01-01')", [userId,projectId,channelId]);
  await pool.query("insert into drafts(user_id,project_id,text,client_key) values($1,$2,'Undated draft','undated')", [userId,projectId]);
  await pool.query("analyze posts"); await pool.query("analyze drafts");
  mocks.pool.mockReturnValue({ query: (sql: string, params: unknown[]) => { if (sql.includes("order by p.id") || sql.includes("order by d.id")) queries.push({ sql, params }); return pool.query(sql, params); } });
}, 30000);
afterAll(async () => { await pool.end(); await admin.end(); });

describe.sequential("calendar completeness on real PostgreSQL", () => {
  it("finds a future post beyond 12000 historical posts", async () => {
    const body = await (await postsGET(request("posts", windowQuery))).json();
    // The first page is bounded; the target is deliberately beyond it too.
    if (body.hasMore === undefined) expect(body.posts.map((r: { id: number }) => r.id)).toContain(futureId);
    else expect(await all("posts", windowQuery)).toContain(futureId);
  });
  it("finds a future draft beyond 12000 recently updated historical drafts", async () => {
    const body = await (await draftsGET(request("drafts", windowQuery))).json();
    if (body.hasMore === undefined) expect(body.drafts.map((r: { id: number }) => r.id)).toContain(futureDraft);
    else expect(await all("drafts", windowQuery)).toContain(futureDraft);
  });
  it("exhausts equal-date pages once, without gaps or duplicates", async () => {
    expect(await all("posts", windowQuery + "&limit=37")).toHaveLength(421);
    expect(await all("drafts", windowQuery + "&limit=37")).toHaveLength(421);
  });
  it("rejects cursors from a different range, resource or authorized project", async () => {
    const first = await page("posts", windowQuery);
    for (const [resource, query, project] of [
      ["posts", "view=undated", projectId], ["drafts", windowQuery, projectId], ["posts", windowQuery, foreignProject],
    ] as const) {
      const response = await (resource === "posts" ? postsGET : draftsGET)(request(resource, `${query}&cursor=${first.nextCursor}`, project));
      expect(response.status).toBe(400);
    }
  });
  it("rejects invalid intervals, duplicate cursors and a stale project timezone", async () => {
    for (const query of [
      "view=range&from=2030-02-30&to=2030-03-01", "view=range&from=2030-01-01&to=2031-01-01",
      "view=range&from=2030-04-01&to=2030-04-01", windowQuery + "&timezone=UTC",
      windowQuery + "&limit=201", windowQuery + "&cursor=a&cursor=b", "view=undated&from=2030-04-01",
    ]) {
      expect((await postsGET(request("posts", query))).status).toBe(400);
      expect((await draftsGET(request("drafts", query))).status).toBe(400);
    }
    expect((await page("posts", windowQuery + "&timezone=Europe%2FAmsterdam")).hasMore).toBe(true);
  });
  it("keeps new high IDs out of an in-progress traversal", async () => {
    const first = await page("posts", windowQuery + "&limit=200");
    const added = Number((await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at) values($1,$2,$3,'Concurrent new','scheduled','2030-04-15T10:00:00Z') returning id", [userId,projectId,channelId])).rows[0].id);
    expect((await all("posts", windowQuery + `&cursor=${first.nextCursor}`))).not.toContain(added);
    expect(await all("posts", windowQuery)).toContain(added);
  });
  it("loads undated and attention records independently of the visible month", async () => {
    expect((await page("posts", "view=undated")).posts.map((r: { text: string }) => r.text)).toEqual(["Undated"]);
    expect((await page("drafts", "view=undated")).drafts.map((r: { text: string }) => r.text)).toEqual(["Undated draft"]);
    expect((await page("posts", "view=attention")).posts.map((r: { text: string }) => r.text)).toEqual(["Old failure"]);
  });
  it("honors half-open project month and DST boundaries", async () => {
    for (const [from,to,start,end] of [
      ["2030-03-31","2030-04-01","2030-03-30T23:00:00Z","2030-03-31T22:00:00Z"],
      ["2030-10-27","2030-10-28","2030-10-26T22:00:00Z","2030-10-27T23:00:00Z"],
    ]) {
      const ids = (await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at) select $1,$2,$3,'Boundary','scheduled',instant from unnest($4::timestamptz[])instant returning id", [userId,projectId,channelId,[new Date(Date.parse(start)-1),start,new Date(Date.parse(end)-1),end]])).rows.map(r=>Number(r.id));
      expect(await all("posts", `view=range&from=${from}&to=${to}`)).toEqual([ids[2],ids[1]]);
    }
  });
  it("opens, moves and cancels the future publication through its existing lifecycle", async () => {
    const opened = (await page("posts", `id=${futureId}`)).posts[0];
    expect(opened.publication_operation_id).toBe(operationId);
    const common = { pool, userId, projectId, operationId, expectedRevision: 1, expectedStatus: "queued", idempotencyKey: randomUUID(), requestId: randomUUID() };
    const moved = await reschedulePublicationOperation({ ...common, scheduledAt: "2030-05-02T10:00:00Z", timezone: "Europe/Amsterdam", offset: "+02:00", disambiguation: "reject" });
    expect(moved).toMatchObject({ ok: true, scheduleRevision: 2 });
    expect(await all("posts", windowQuery)).not.toContain(futureId);
    expect(await all("posts", "view=range&from=2030-05-01&to=2030-06-01")).toContain(futureId);
    expect(await cancelPublicationOperation({ ...common, expectedRevision: 2, expectedStatus: "pending", idempotencyKey: randomUUID() })).toMatchObject({ ok: true, status: "cancelled" });
    expect((await page("posts", `id=${futureId}`)).posts[0].status).toBe("cancelled");
  });
  it("denies a next page after membership revocation", async () => {
    const first = await page("posts", windowQuery);
    await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [projectId,userId]);
    expect((await postsGET(request("posts", `${windowQuery}&cursor=${first.nextCursor}`))).status).toBe(403);
    await pool.query("update project_members set status='active',revoked_at=null where project_id=$1 and user_id=$2", [projectId,userId]);
  });
  it("records actual query plans for measured index decisions", async () => {
    const plans = [];
    for (const resource of ["posts", "drafts"] as const) {
      for (const scenario of ["first", "last", "empty"] as const) {
        queries.length = 0;
        if (scenario === "last") await all(resource, windowQuery);
        else await page(resource, scenario === "empty" ? "view=range&from=2030-07-01&to=2030-08-01" : windowQuery);
        const {sql,params} = queries.at(-1)!;
        plans.push({resource,scenario,sql,params,plan:(await pool.query(`explain (analyze,buffers,format json) ${sql}`,params)).rows[0]["QUERY PLAN"]});
      }
    }
    if (process.env.CALENDAR_PLAN_DIR) {
      await mkdir(process.env.CALENDAR_PLAN_DIR,{recursive:true});
      await writeFile(`${process.env.CALENDAR_PLAN_DIR}/query-plans.json`,JSON.stringify({database,plans},null,2));
    }
    expect(plans).toHaveLength(6);
  });
});
