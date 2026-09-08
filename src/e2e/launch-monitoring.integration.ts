import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { publicationMetrics, socialConnectionMetrics } from "@/lib/admin-system-diagnostics";

const target = new URL(String(process.env.DATABASE_URL));
if (target.hostname !== "127.0.0.1" || target.port !== "55437") throw new Error("Isolated local PostgreSQL required");
const admin = new pg.Pool({ connectionString: target.href });
const database = `aurora_monitor_${randomUUID().replaceAll("-", "")}`;
target.pathname = `/${database}`;
const pool = new pg.Pool({ connectionString: target.href });
const now = "2030-04-10T10:00:00.000Z";
let userId: number, projectId: number, channelId: number, postId: number;
beforeAll(async () => {
  await admin.query(`create database ${database}`);
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  userId = Number((await pool.query("insert into users(email) values('monitor@example.test') returning id")).rows[0].id);
  projectId = Number((await pool.query("insert into projects(name,timezone,created_by_user_id) values('Monitor','UTC',$1) returning id", [userId])).rows[0].id);
  await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'owner')", [projectId,userId]);
  channelId = Number((await pool.query("insert into channels(user_id,project_id,network,title,tg_chat_id,is_active) values($1,$2,'tg','Monitor',-10091238888,true) returning id", [userId,projectId])).rows[0].id);
  const operationId = Number((await pool.query("insert into publication_operations(project_id,user_id,draft_version,idempotency_key,fingerprint,text,scheduled_at,timezone,destination_ids,status) values($1,$2,1,'monitor-operation',$3,'Monitor','2030-04-11T10:00:00Z','UTC',$4::jsonb,'queued') returning id", [projectId,userId,'f'.repeat(64),JSON.stringify([channelId])])).rows[0].id);
  postId = Number((await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at,publication_operation_id) values($1,$2,$3,'Monitor','scheduled','2030-04-11T10:00:00Z',$4) returning id", [userId,projectId,channelId,operationId])).rows[0].id);
  await pool.query("insert into publication_outbox(operation_id,post_id,created_at,next_attempt_at) values($1,$2,$3::timestamptz-interval '10 minutes',$3::timestamptz-interval '7 minutes')", [operationId,postId,now]);
});
afterAll(async () => { await pool.end(); await admin.end(); });

describe.sequential("launch monitoring on PostgreSQL", () => {
  it("detects a committed outbox stuck before Redis even while the publication is tomorrow", async () => {
    expect(await publicationMetrics(pool, now)).toMatchObject({ waiting: 1, overdue: 0, scheduleLagMs: null,
      outboxPending: 1, outboxOverdue: 1, oldestOutboxAgeMs: 600_000, unverified: 0 });
  });
  it("shows age during bounded backoff without claiming the next attempt is overdue", async () => {
    await pool.query("update publication_outbox set status='failed',next_attempt_at=$1::timestamptz+interval '1 minute' where post_id=$2", [now,postId]);
    expect(await publicationMetrics(pool, now)).toMatchObject({ outboxPending: 1, outboxOverdue: 0, oldestOutboxAgeMs: 600_000 });
    await pool.query("update posts set status='cancelled' where id=$1", [postId]);
    expect(await publicationMetrics(pool, now)).toMatchObject({ outboxPending: 0, outboxOverdue: 0, oldestOutboxAgeMs: null });
  });
  it("distinguishes scheduled lag from an unknown provider result and clears recovered counters", async () => {
    await pool.query("update posts set status='scheduled',scheduled_at=$1::timestamptz-interval '8 minutes' where id=$2", [now,postId]);
    expect(await publicationMetrics(pool, now)).toMatchObject({ overdue: 1, scheduleLagMs: 480_000, unverified: 0 });
    await pool.query("update posts set status='published_unverified' where id=$1", [postId]);
    expect(await publicationMetrics(pool, now)).toMatchObject({ overdue: 0, scheduleLagMs: null, unverified: 1, outboxPending: 0 });
    await pool.query("update posts set status='published',published_at=$1 where id=$2", [now,postId]);
    expect(await publicationMetrics(pool, now)).toMatchObject({ successes: 1, unverified: 0, outboxPending: 0 });
  });
  it("keeps deactivated auth failures visible and excludes an explicitly disconnected channel", async () => {
    expect(await socialConnectionMetrics(pool, now)).toMatchObject({ connected: 1, attention: 0 });
    await pool.query("update channels set is_active=false,status='permission_lost',last_auth_error_code='CHAT_ADMIN_REQUIRED',last_auth_error_at=$1 where id=$2", [now,channelId]);
    expect(await socialConnectionMetrics(pool, now)).toMatchObject({ connected: 0, attention: 1, lastFailureAt: now });
    await pool.query("update channels set status='disconnected' where id=$1", [channelId]);
    expect(await socialConnectionMetrics(pool, now)).toMatchObject({ connected: 0, attention: 0, lastFailureAt: null });
    await pool.query("update channels set is_active=true,status='active',last_auth_error_at=null,last_auth_error_code=null where id=$1", [channelId]);
    expect(await socialConnectionMetrics(pool, now)).toMatchObject({ connected: 1, attention: 0, lastFailureAt: null });
  });
});
