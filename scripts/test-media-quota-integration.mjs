import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
import { migrate } from "./migrate.mjs";
import {configureMediaStorageLimits} from "../src/lib/media-storage-quota.mjs";
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const target = new URL(databaseUrl || "postgres://invalid/invalid");
assert(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) && target.pathname === "/aurora_media_quota_test", "explicit disposable aurora_media_quota_test database required");
assert(!process.env.DATABASE_URL, "application DATABASE_URL must not be inherited");
const pool = new pg.Pool({ connectionString: databaseUrl, max: 24 });
try {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { DATABASE_URL: databaseUrl } });
  const policyExists = (await pool.query("select to_regclass('public.media_storage_policy') as name")).rows[0].name;
  if (policyExists) await pool.query("insert into media_storage_policy (id,user_max_bytes,project_max_bytes,global_max_bytes) values (1,1024,1536,2048) on conflict(id) do update set user_max_bytes=1024,project_max_bytes=1536,global_max_bytes=2048");
  const nonce = Date.now();
  const user = Number((await pool.query("insert into users(email,name) values($1,'quota fixture') returning id", [`quota-${nonce}@example.invalid`])).rows[0].id);
  const other = Number((await pool.query("insert into users(email,name) values($1,'quota fixture') returning id", [`quota-other-${nonce}@example.invalid`])).rows[0].id);
  const project = Number((await pool.query("insert into projects(name,created_by_user_id) values('quota fixture',$1) returning id", [user])).rows[0].id);
  const otherProject = Number((await pool.query("insert into projects(name,created_by_user_id) values('quota other fixture',$1) returning id", [other])).rows[0].id);
  async function upload(userId, projectId, index, db=pool) {
    const data = Buffer.alloc(256, index);
    return (await db.query("insert into media_assets(user_id,project_id,kind,file_name,mime_type,bytes,data,sha256,origin) values($1,$2,'image',$3,'image/png',256,$4,$5,'upload') returning id", [userId,projectId,`fixture-${index}.png`,data,createHash('sha256').update(data).digest('hex')])).rows[0];
  }
  if(policyExists){
    await pool.query('delete from media_storage_policy');
    await assert.rejects(upload(user,project,200),/media_storage_limits_not_configured/);
    await configureMediaStorageLimits(pool,{userMaxBytes:1024,projectMaxBytes:1536,globalMaxBytes:2048},{apply:true});
  }
  const first = await Promise.allSettled(Array.from({length:24}, (_,index)=>upload(user,project,index)));
  const accepted = first.filter(result=>result.status==='fulfilled');
  console.log(JSON.stringify({ stage:'user_concurrency', attempted:24,accepted:accepted.length,expectedMaximum:4 }));
  assert.equal(accepted.length,4,"parallel unique uploads must honor cumulative user bytes");
  assert(first.filter(result=>result.status==='rejected').every(result=>result.reason.message.startsWith('media_storage_quota_exceeded:')));
  const second=await Promise.allSettled(Array.from({length:12},(_,index)=>upload(other,project,index+40)));
  assert.equal(second.filter(result=>result.status==='fulfilled').length,2,"project cap applies across users");
  const third=await Promise.allSettled(Array.from({length:12},(_,index)=>upload(other,otherProject,index+70)));
  assert.equal(third.filter(result=>result.status==='fulfilled').length,2,"global cap applies across projects");
  const before=Number((await pool.query("select bytes_used from media_storage_usage where scope='global' and scope_id=0")).rows[0].bytes_used);
  assert.equal(before,2048);
  await pool.query('delete from media_assets where id=$1',[accepted[0].value.id]);
  assert.equal(Number((await pool.query("select bytes_used from media_storage_usage where scope='global' and scope_id=0")).rows[0].bytes_used),1792);
  const tx=await pool.connect();
  try { await tx.query('begin'); await upload(user,project,99,tx); await tx.query('rollback'); }
  finally {tx.release();}
  assert.equal(Number((await pool.query("select bytes_used from media_storage_usage where scope='global' and scope_id=0")).rows[0].bytes_used),1792,"rolled-back asset insert must release usage");
  await upload(user,project,100);
  const total=Number((await pool.query('select sum(greatest(bytes,coalesce(octet_length(data),0))) as actual from media_assets')).rows[0].actual);
  assert.equal(total,2048);
  await assert.rejects(configureMediaStorageLimits(pool,{userMaxBytes:1024,projectMaxBytes:1536,globalMaxBytes:1024},{apply:true}),/below_existing_usage/);
  await assert.rejects(pool.query("insert into media_assets(user_id,project_id,kind,file_name,mime_type,bytes,data,sha256) values($1,$2,'image','understated.png','image/png',1,$3,$4)",[user,project,Buffer.alloc(1024),'b'.repeat(64)]),/media_storage_quota_exceeded/);
  assert.equal(Number((await pool.query("select bytes_used from media_storage_usage where scope='global'")).rows[0].bytes_used),2048);
  console.log(JSON.stringify({ok:true,userCap:true,projectCap:true,globalCap:true,concurrentAttempts:48,accepted:8,deleteRelease:true,rollbackRelease:true,actualBytes:total,missingPolicyFailClosed:true,policyCannotUndercutUsage:true,understatedPayloadRejected:true,providerCalls:0}));
} finally {await pool.end();}
