import assert from "node:assert/strict";
import pg from "pg";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { migrate } from "./migrate.mjs";
import { encryptToken, decryptToken } from "../src/lib/token-crypto.mjs";

import { assertRestoredDatabaseTarget, quarantineRestoredPublications as currentQuarantine } from "./prepare-restored-publications.mjs";
import { claimPublicationLease } from "../worker/publication-lease.mjs";
const databaseUrl = process.env.RESTORE_DATABASE_URL;
assertRestoredDatabaseTarget(databaseUrl, true);
assert.equal(process.env.AURORA_OUTBOUND_DISABLED, "1", "restore rehearsal requires outbound hold");
assert(!process.env.DATABASE_URL, "application DATABASE_URL must not be inherited");
// Regression-only seam for the frozen prechange quarantine implementation.
const quarantineRestoredPublications = process.env.RESTORE_QUARANTINE_SOURCE
  ? (await import(process.env.RESTORE_QUARANTINE_SOURCE)).quarantineRestoredPublications
  : currentQuarantine;

const sourceUrl=process.env.MIGRATION_TEST_DATABASE_URL;
const sourceTarget=new URL(sourceUrl || "postgres://invalid/invalid");
assert(["127.0.0.1","localhost","[::1]"].includes(sourceTarget.hostname)
  && ["/aurora_restore_source_test","/aurora_s02_test"].includes(sourceTarget.pathname), "explicit disposable restore source required");
assert.notEqual(sourceUrl,databaseUrl);
const pool = new pg.Pool({ connectionString: databaseUrl });
const source=new pg.Pool({connectionString:sourceUrl});
const directory=await mkdtemp(join(tmpdir(),"aurora-restore-fixture-"));
const dumpPath=join(directory,"fixture.dump");
const run=promisify(execFile);
const started=performance.now();
const originalEnv={TOKENS_MASTER_KEY:process.env.TOKENS_MASTER_KEY,TOKENS_KEY_ID:process.env.TOKENS_KEY_ID,TOKENS_OLD_KEYS:process.env.TOKENS_OLD_KEYS};
// This key is synthetic and exists solely in this process; it is never in the dump.
process.env.TOKENS_MASTER_KEY="aurora-disposable-restore-fixture-only";process.env.TOKENS_KEY_ID="fixture";process.env.TOKENS_OLD_KEYS="{}";
try {
  await assert.rejects(run(process.execPath,[fileURLToPath(new URL("../worker/outbound-guard.mjs",import.meta.url))],{timeout:10_000}), /worker_outbound_disabled/);
  await source.query("drop schema public cascade");await source.query("create schema public");
  await source.query(await readFile(new URL("../db/schema.sql",import.meta.url),"utf8"));
  await migrate({env:{DATABASE_URL:sourceUrl},logger:{log(){}}});
  await source.query("insert into media_storage_policy(id,user_max_bytes,project_max_bytes,global_max_bytes) values(1,65536,65536,65536)");
  const user=Number((await source.query("insert into users(email,name) values('restore@example.invalid','fixture') returning id")).rows[0].id);
  const project=Number((await source.query("insert into projects(name,created_by_user_id) values('restore fixture',$1) returning id",[user])).rows[0].id);
  const syntheticToken="synthetic-provider-token-no-real-access";
  const envelope=encryptToken(syntheticToken,{userId:user,provider:"vk"});
  const channel=(await source.query("insert into channels(user_id,project_id,network,vk_group_id,vk_token,title) values($1,$2,'vk',987,$3,'fixture') returning id",[user,project,envelope])).rows[0].id;
  const bytes=Buffer.from("synthetic postgres media restore fixture");
  const digest=createHash("sha256").update(bytes).digest("hex");
  const media=(await source.query("insert into media_assets(user_id,project_id,kind,file_name,mime_type,bytes,data,sha256) values($1,$2,'image','fixture.png','image/png',$3,$4,$5) returning id",[user,project,bytes.length,bytes,digest])).rows[0].id;
  const posts=[];
  for(const state of ["scheduled","failed_retry","publishing","quarantined"]){
    const post=(await source.query("insert into posts(user_id,project_id,channel_id,text,media,status,scheduled_at) values($1,$2,$3,'fixture',$4,$5,now()) returning id",[user,project,channel,JSON.stringify({assetId:media}),state])).rows[0].id;posts.push(post);
  }
  await source.query("insert into publication_parts(post_id,part_index,part_type,send_status,external_message_id) values($1,0,'text','sent','fixture-success'),($1,1,'text','sending',null)",[posts[0]]);
  await source.query("insert into telegram_update_deliveries(bot_id,update_id,part_index,payload_hash,send_status) values(123,456,0,$1,'sending')",['a'.repeat(64)]);
  for (const [index, status] of ['sending','rejected','sent','unknown','cancelled'].entries()) {
    await source.query("insert into telegram_background_deliveries(project_id,user_id,event_key,part_index,bot_id,chat_id,payload_hash,send_status) values($1,$2,'restore-event', $3,123,456,$4,$5)", [project,user,index,'b'.repeat(64),status]);
  }
  await source.query("insert into admin_alert_conditions(alert_id,firing,generation,since_ms) values('database',true,1,1)");
  const notification=(await source.query("insert into admin_alert_notifications(alert_id,generation,kind,severity,detail,since_ms) values('database',1,'fired','critical','synthetic fixture',1) returning id")).rows[0].id;
  for(const [index,status] of ['pending','sending','rejected','sent','unknown'].entries()){
    const recipient=(await source.query("insert into users(email) values($1) returning id",[`restore-alert-${index}@example.invalid`])).rows[0].id;
    await source.query("insert into admin_alert_deliveries(notification_id,user_id,chat_id,bot_id,send_status) values($1,$2,$3,123,$4)",[notification,recipient,100+index,status]);
  }
  const dumpStarted=performance.now();
  await run(process.env.PG_DUMP_BIN||"pg_dump",["--format=custom","--no-owner","--no-acl","--file",dumpPath,sourceUrl],{timeout:60_000,maxBuffer:1024*1024});
  const dumpMs=performance.now()-dumpStarted;
  const dumpBytes=(await stat(dumpPath)).size;
  await pool.query("drop schema public cascade");await pool.query("create schema public");
  const restoreStarted=performance.now();
  await run(process.env.PG_RESTORE_BIN||"pg_restore",["--clean","--if-exists","--no-owner","--no-acl","--dbname",databaseUrl,dumpPath],{timeout:60_000,maxBuffer:1024*1024});
  const restoreMs=performance.now()-restoreStarted;
  const restoredMedia=(await pool.query("select data,sha256 from media_assets where id=$1",[media])).rows[0];
  assert.equal(createHash("sha256").update(restoredMedia.data).digest("hex"),digest);
  assert.equal(restoredMedia.sha256,digest);
  assert.equal(decryptToken((await pool.query("select vk_token from channels where id=$1",[channel])).rows[0].vk_token,{userId:user,provider:"vk"}),syntheticToken);
  assert.equal(Number((await pool.query("select bytes_used from media_storage_usage where scope='global'")).rows[0].bytes_used),bytes.length);
  const before = await quarantineRestoredPublications(pool);
  assert.equal(before.mode, "dry_run");
  assert(Object.values(before.report).every((entry) => !entry.changed));
  const applied = await quarantineRestoredPublications(pool, { apply: true });
  assert.equal(applied.resumeAllowed, false);
  const repeated = await quarantineRestoredPublications(pool, { apply: true });
  assert(Object.values(repeated.report).every((entry) => !entry.changed), "restore quarantine must be idempotent");
  const restored = (await pool.query("select id,project_id,schedule_revision from posts where verification_error_code='restored_delivery_unknown'")).rows;
  assert(restored.length > 0, "a restored fixture containing formerly queued sends is required");
  for (const post of restored) {
    for (const revision of [Number(post.schedule_revision) - 1, Number(post.schedule_revision)]) {
      assert.equal(await claimPublicationLease(pool, { postId: post.id, projectId: post.project_id, scheduleRevision: revision, leaseToken: "restore-test", overdueCutoff: new Date(0) }), null);
    }
  }
  assert.equal(Number((await pool.query("select count(*) as count from posts where status in ('scheduled','failed_retry','publishing')")).rows[0].count), 0);
  assert.equal((await pool.query("select send_status from publication_parts where external_message_id='fixture-success'")).rows[0].send_status,"sent");
  assert.equal((await pool.query("select send_status from publication_parts where external_message_id is null")).rows[0].send_status,"unknown");
  assert.equal((await pool.query("select send_status from telegram_update_deliveries")).rows[0].send_status,"unknown");
  assert.deepEqual((await pool.query("select send_status from telegram_background_deliveries order by part_index")).rows.map(row=>row.send_status), ['unknown','unknown','sent','unknown','cancelled']);
  assert.equal(applied.report.telegram_background_deliveries.changed, 2);
  assert.equal(applied.report.admin_alert_notifications.changed,1);
  assert.equal(Number((await pool.query("select count(*) as n from admin_alert_notifications where completed_at is null and superseded_at is null")).rows[0].n),0);
  assert.equal(applied.report.admin_alert_deliveries.changed,3);
  assert.deepEqual((await pool.query("select send_status from admin_alert_deliveries order by chat_id")).rows.map(row=>row.send_status),['unknown','unknown','unknown','sent','unknown']);
  await pool.end();
  const restarted=new pg.Pool({connectionString:databaseUrl});
  try {
    assert.equal((await restarted.query("select count(*)::int as n from posts where verification_error_code='restored_delivery_unknown'")).rows[0].n,4);
    assert.deepEqual((await restarted.query("select send_status from telegram_background_deliveries order by part_index")).rows.map(row=>row.send_status), ['unknown','unknown','sent','unknown','cancelled']);
  }
  finally {await restarted.end();}
  console.log(JSON.stringify({ ok: true, standaloneFreshFixture:true, dumpBytes, dumpMs:Math.round(dumpMs),restoreMs:Math.round(restoreMs),totalMs:Math.round(performance.now()-started),mediaDigestPreserved:true,syntheticTokenDecrypted:true,successfulReceiptPreserved:true,restoredAdminAlertReceiptsHeld:true,restoredBackgroundReceiptsHeld:true,unknownDurableAcrossPoolRestart:true, restoredPosts: restored.length, oldAndCurrentRevisionClaims: "denied", idempotent: true, providerCalls: 0, resumeAllowed: false }));
} finally {
  if(!pool.ended)await pool.end();await source.end();await rm(directory,{recursive:true,force:true});
  for(const [key,value] of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
}
