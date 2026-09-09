import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {telegramPartDefinitions,deliverTelegramParts} from '../worker/telegram-multipart.mjs';
import {telegramCarouselPartDefinitions,deliverTelegramCarousel} from '../worker/telegram-carousel.mjs';
const workerSource=await readFile(process.env.PUBLICATION_WORKER_SOURCE||new URL('../worker.mjs',import.meta.url),'utf8');
const publishSource=workerSource.slice(workerSource.indexOf('async function publishTg('),workerSource.indexOf('/** VK: расшифровываем',workerSource.indexOf('async function publishTg(')));
import {migrate} from './migrate.mjs';
const lease=await import(process.env.PUBLICATION_LEASE_SOURCE?pathToFileURL(process.env.PUBLICATION_LEASE_SOURCE).href:new URL('../worker/publication-lease.mjs',import.meta.url).href);
const target=new URL(process.env.MIGRATION_TEST_DATABASE_URL||'postgres://invalid/invalid');
assert(['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&target.pathname==='/aurora_publication_authority_test');
assert(!process.env.DATABASE_URL,'application database must not be inherited');
const pool=new pg.Pool({connectionString:target.href,max:6});
const failures=[];let scenarios=0,admittedCalls=0;
try{
 await pool.query('drop schema public cascade');await pool.query('create schema public');await pool.query(await readFile(new URL('../db/schema.sql',import.meta.url),'utf8'));await migrate({env:{DATABASE_URL:target.href},logger:{log(){}}});
 const users=(await pool.query("insert into users(email) values('publisher@authority.invalid'),('connector@authority.invalid') returning id")).rows;
 const actor=users[0].id,connector=users[1].id;
 const project=(await pool.query("insert into projects(name,created_by_user_id) values('fixture',$1) returning id",[actor])).rows[0].id;
 await pool.query("insert into project_members(project_id,user_id,role,status) values($1,$2,'publisher','active'),($1,$3,'owner','active')",[project,actor,connector]);
 const channel=(await pool.query("insert into channels(user_id,project_id,network,tg_chat_id,title) values($1,$2,'tg',-987123456,'fixture') returning id",[connector,project])).rows[0].id;
 async function restore(){await pool.query('update users set blocked_at=null,blocked_reason=null where id=$1',[actor]);await pool.query('update projects set is_archived=false where id=$1',[project]);await pool.query("update project_members set status='active',revoked_at=null,role=case when user_id=$2 then 'publisher' else 'owner' end where project_id=$1",[project,actor]);await pool.query("update channels set is_active=true,status='active' where id=$1",[channel]);}
 async function input(status='scheduled'){const post=(await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at,next_attempt_at) values($1,$2,$3,'fixture',$4,now(),now()) returning id",[actor,project,channel,status])).rows[0];return{postId:post.id,projectId:project,scheduleRevision:1,leaseToken:`fixture-${post.id}`,overdueCutoff:new Date(0)};}
 const mutations={account_blocked:["update users set blocked_at=now(),blocked_reason='fixture' where id=$1",[actor]],archive:["update projects set is_archived=true where id=$1",[project]],revoke:["update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2",[project,actor]],demote:["update project_members set role='author' where project_id=$1 and user_id=$2",[project,actor]],channel_revoked:["update channels set status='revoked' where id=$1",[channel]],channel_permission_lost:["update channels set status='permission_lost' where id=$1",[channel]]};
 async function test(name,fn){try{await restore();await fn();scenarios++;console.log(`PASS ${name}`);}catch(error){failures.push(name);console.error(`FAIL ${name}: ${error.message}`);}}
 for(const [name,mutation]of Object.entries(mutations)){
  for(const status of ['scheduled','failed_retry'])await test(`${name} before ${status} claim`,async()=>{const job=await input(status);await pool.query(...mutation);const claimed=await lease.claimPublicationLease(pool,job);if(claimed)admittedCalls++;assert.equal(claimed,null,'revoked authority must not claim new work');});
  await test(`${name} after claim before provider`,async()=>{const job=await input();assert(await lease.claimPublicationLease(pool,job));await pool.query(...mutation);const admitted=await lease.beginProviderCall(pool,job);if(admitted)admittedCalls++;assert.equal(admitted,false,'no provider call after committed revocation');assert.equal((await pool.query('select provider_started_at from posts where id=$1',[job.postId])).rows[0].provider_started_at,null);});
 }
 await test('unrelated connector/author revocation preserves authorized publisher schedule',async()=>{const job=await input();await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2",[project,connector]);assert(await lease.claimPublicationLease(pool,job));assert.equal(await lease.beginProviderCall(pool,job),true);assert.equal(await lease.beginProviderCall(pool,job),false,'admission remains one shot');});
 for(const [name,mutation]of Object.entries(mutations))await test(`${name} uncommitted mutation wins final admission`,async()=>{
  const job=await input();assert(await lease.claimPublicationLease(pool,job));const tx=await pool.connect();await tx.query('begin');await tx.query(...mutation);
  const runner=await pool.connect();const pid=(await runner.query('select pg_backend_pid() as pid')).rows[0].pid;
  let settled=false;const admission=lease.beginProviderCall(runner,job).then(value=>{settled=true;return value;});
  let waited=false;const deadline=Date.now()+2000;
  while(!settled&&Date.now()<deadline){const state=(await pool.query('select wait_event_type from pg_stat_activity where pid=$1',[pid])).rows[0];if(state?.wait_event_type==='Lock'){waited=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  await tx.query('commit');tx.release();const admitted=await admission;runner.release();if(admitted)admittedCalls++;
  assert.equal(waited,true,'admission must serialize with in-flight authority mutation');assert.equal(admitted,false,'new statement snapshot must not authorize pre-revocation row');
 });
 for(const [name,mutation]of Object.entries(mutations))await test(`${name} between successful Telegram parts`,async()=>{
  const job=await input();assert(await lease.claimPublicationLease(pool,job));assert(await lease.beginProviderCall(pool,job));let calls=0;
  const publish=vm.runInNewContext(`${publishSource}\npublishTg`,{pool,createHash,telegramPartDefinitions,deliverTelegramParts,telegramCarouselPartDefinitions,deliverTelegramCarousel,claimPublicationPart:lease.claimPublicationPart,classifyTelegramChannelFailure:()=>null,tgSendHtml:async()=>{calls++;if(calls===1)await pool.query(...mutation);return{ok:true,result:{message_id:800+calls}};}});
  const channelRow=(await pool.query('select * from channels where id=$1',[channel])).rows[0];
  const result=await publish(channelRow,job.postId,'x'.repeat(4100),null,job);
  assert.equal(calls,1,'second part must not send after committed revocation');assert.equal(result.deliveryUnknown,true,'partially delivered post must require explicit review');
  const parts=(await pool.query('select send_status,external_message_id from publication_parts where post_id=$1 order by part_index',[job.postId])).rows;
  assert.equal(parts[0].send_status,'sent');assert.equal(parts[0].external_message_id,'801');assert.equal(parts[1].send_status,'pending');
 });
 await test('parallel distinct posts do not deadlock on calendar snapshot counter',async()=>{
  const jobs=await Promise.all(Array.from({length:12},()=>input()));
  const claims=await Promise.all(jobs.map(job=>lease.claimPublicationLease(pool,job)));assert(claims.every(Boolean));
  const admissions=await Promise.all(jobs.map(job=>lease.beginProviderCall(pool,job)));assert(admissions.every(Boolean));
 });
 await test('part lease and schedule revision stay fenced',async()=>{
  const job=await input();assert(await lease.claimPublicationLease(pool,job));assert(await lease.beginProviderCall(pool,job));
  const part=(await pool.query("insert into publication_parts(post_id,part_index,part_type,payload_html) values($1,0,'text','fixture') returning id",[job.postId])).rows[0];
  assert.equal((await lease.claimPublicationPart(pool,{...job,partId:part.id,leaseToken:'stale'})).rowCount,0);
  assert.equal((await lease.claimPublicationPart(pool,{...job,partId:part.id,scheduleRevision:2})).rowCount,0);
  assert.equal((await lease.claimPublicationPart(pool,{...job,partId:part.id})).rowCount,1);
 });
 await test('OAuth token revocation blocks first and later provider steps',async()=>{
  const token=(await pool.query("insert into oauth_tokens(user_id,provider,access_token,external_id) values($1,'youtube','synthetic-no-access','synthetic') returning id",[connector])).rows[0].id;
  const destination=(await pool.query("insert into channels(user_id,project_id,network,oauth_token_id,title) values($1,$2,'youtube',$3,'synthetic') returning id",[connector,project,token])).rows[0].id;
  const job=await input();await pool.query('update posts set channel_id=$2 where id=$1',[job.postId,destination]);
  assert(await lease.claimPublicationLease(pool,job));await pool.query('update oauth_tokens set is_active=false where id=$1',[token]);assert.equal(await lease.beginProviderCall(pool,job),false);
  await pool.query('update oauth_tokens set is_active=true where id=$1',[token]);assert(await lease.beginProviderCall(pool,job));assert(await lease.authorizeProviderStep(pool,job));
  await pool.query('update oauth_tokens set is_active=false where id=$1',[token]);assert.equal(await lease.authorizeProviderStep(pool,job),false);
 });
 await test('channel provider identity snapshot must still match before initial and later sends',async()=>{
  const original=(await pool.query('select * from channels where id=$1',[channel])).rows[0];
  const job={...await input(),expectedChannel:original};assert(await lease.claimPublicationLease(pool,job));
  await pool.query('update channels set tg_chat_id=tg_chat_id-100 where id=$1',[channel]);assert.equal(await lease.beginProviderCall(pool,job),false);
  await pool.query('update channels set tg_chat_id=$2 where id=$1',[channel,original.tg_chat_id]);assert(await lease.beginProviderCall(pool,job));
  const part=(await pool.query("insert into publication_parts(post_id,part_index,part_type,payload_html) values($1,0,'text','fixture') returning id",[job.postId])).rows[0];
  await pool.query('update channels set tg_chat_id=tg_chat_id-100 where id=$1',[channel]);
  assert.equal((await lease.claimPublicationPart(pool,{...job,partId:part.id})).rowCount,0);
  assert.equal(await lease.authorizeProviderStep(pool,job),false);
 });
 console.log(JSON.stringify({ok:failures.length===0,scenarios,failures,unauthorizedAdmittedCalls:admittedCalls,realProviderCalls:0,database:'isolated real PostgreSQL'}));assert.equal(failures.length,0);
}finally{await pool.end();}
