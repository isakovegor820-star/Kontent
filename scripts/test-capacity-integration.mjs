import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { migrate } from "./migrate.mjs";
import { claimPublicationLease, beginProviderCall } from "../worker/publication-lease.mjs";

const target = new URL(process.env.MIGRATION_TEST_DATABASE_URL || "http://invalid");
assert(["localhost", "127.0.0.1"].includes(target.hostname) && target.pathname === "/aurora_capacity_test", "explicit disposable aurora_capacity_test required");
assert(!process.env.DATABASE_URL, "do not inherit application connections");
const pool = new pg.Pool({ connectionString: target.href, max: 3 });
const source = await readFile(new URL("../src/app/api/posts/route.ts", import.meta.url), "utf8");
const query = source.match(/`(select calendar_page\.\*, snapshot\.calendar_version[\s\S]*?order by calendar_page\.scheduled_at nulls last, calendar_page\.id)`/u)?.[1];
assert(query, "load test must exercise the actual calendar route SQL");
function summary(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(2));
  return { samples: values.length, p50Ms: at(.5), p95Ms: at(.95), p99Ms: at(.99), maxMs: at(1) };
}
const report = { kind: "synthetic local capacity characterization; no agreed production peak or SLO", databasePoolMax: 3, scales: [], providerCalls: 0 };
try {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { DATABASE_URL: target.href }, logger: { log() {} } });
  const user = Number((await pool.query("insert into users(email) values('capacity@example.test') returning id")).rows[0].id);
  const project = Number((await pool.query("insert into projects(name,created_by_user_id) values('Synthetic capacity',$1) returning id", [user])).rows[0].id);
  await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'owner')", [project, user]);
  const channel = Number((await pool.query("insert into channels(user_id,project_id,network,tg_chat_id,title) values($1,$2,'tg',-100707070,'Synthetic capacity') returning id", [user, project])).rows[0].id);
  const walStart = (await pool.query("select pg_current_wal_lsn() as lsn")).rows[0].lsn;
  let previous = 0;
  for (const count of [1000, 10000, 100000]) {
    await pool.query(`insert into posts(user_id,project_id,channel_id,text,status,scheduled_at)
      select $1,$2,$3,'Synthetic load row '||i,case when i%2=0 then 'published' else 'scheduled' end,
        '2026-01-01'::timestamptz+make_interval(mins=>i) from generate_series($4::integer,$5::integer) i`, [user, project, channel, previous + 1, count]);
    previous = count;
    await pool.query("analyze posts");
    const args = [project, "2026-01-01T00:00:00Z", "2026-01-08T00:00:00Z", null, null, 201, null];
    const plan = (await pool.query("explain (analyze,buffers,format json) " + query, args)).rows[0]["QUERY PLAN"][0];
    const nodes = (node) => [node, ...(node.Plans || []).flatMap(nodes)];
    assert(nodes(plan.Plan).filter((node) => node["Node Type"] === "Aggregate").every((node) => node["Actual Loops"] <= 201), "calendar must bound per-post enrichment to the requested page before scanning its full history");
    const latencies = [];
    const started = performance.now();
    // Saturate the same bounded pool with 100 simultaneous reads, including pool wait.
    await Promise.all(Array.from({ length: 100 }, async () => {
      const begin = performance.now();
      const rows = (await pool.query(query, args)).rows;
      assert(rows.length <= 201 && rows.every((row) => new Date(row.scheduled_at) >= new Date(args[1]) && new Date(row.scheduled_at) < new Date(args[2])));
      latencies.push(performance.now() - begin);
    }));
    const row = { rows: count, multiplier: count / 1000, read: summary(latencies), wallMs: Number((performance.now() - started).toFixed(2)), plan };
    report.scales.push(row);
    console.log(JSON.stringify({ ...row, plan: { planningMs: plan["Planning Time"], executionMs: plan["Execution Time"], root: plan.Plan["Node Type"] } }));
  }
  const due = Number((await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at) values($1,$2,$3,'Lease contention','scheduled',now()) returning id", [user, project, channel])).rows[0].id);
  const claims = [];
  const winners = (await Promise.all(Array.from({ length: 100 }, async (_, index) => {
    const started = performance.now();
    const input = { postId: due, projectId: project, scheduleRevision: 1, leaseToken: `capacity-${index}`, overdueCutoff: new Date(0) };
    const claimed = await claimPublicationLease(pool, input);
    claims.push(performance.now() - started);
    return claimed && await beginProviderCall(pool, input) ? input : null;
  }))).filter(Boolean);
  assert.equal(winners.length, 1, "saturation must not permit duplicate provider starts");
  report.claimContention = { attempts: 100, winners: winners.length, timing: summary(claims) };
  report.storage = (await pool.query("select pg_database_size(current_database())::text as database_bytes, pg_total_relation_size('posts')::text as posts_bytes, pg_wal_lsn_diff(pg_current_wal_lsn(),$1)::text as generated_wal_bytes", [walStart])).rows[0];
  report.memory = process.memoryUsage();
  report.ok = true;
  if (process.env.CAPACITY_REPORT_PATH) await writeFile(process.env.CAPACITY_REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, claimContention: report.claimContention, storage: report.storage, providerCalls: 0 }));
} finally { await pool.end(); }
