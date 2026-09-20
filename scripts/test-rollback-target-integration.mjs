import assert from 'node:assert/strict';
import {readFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import vm from 'node:vm';
import pg from 'pg';
const sha='2161d5d0ba7b73143a3a353565015f68bb1a7fa4';
const directory=process.env.ROLLBACK_TARGET_DIRECTORY;
assert(directory,'explicit archived rollback directory required');
assert.equal(process.env.AURORA_OUTBOUND_DISABLED,'1');
assert(!process.env.DATABASE_URL,'application database must not be inherited');
const databaseUrl=process.env.RESTORE_DATABASE_URL;const target=new URL(databaseUrl||'postgres://invalid/invalid');
assert(['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&/^\/aurora_[a-z0-9_]+_restore_test$/u.test(target.pathname));
await assert.rejects(access(join(directory,'.env.local')),'archive must not contain real runtime environment');
const run=promisify(execFile);
const originals=['worker.mjs','worker/telegram-multipart.mjs','worker/telegram-carousel.mjs','worker/publication-lease.mjs','src/lib/schema-readiness.mjs','src/lib/schema-manifest.mjs'];
for(const path of originals){const expected=(await run('git',['show',`${sha}:${path}`],{maxBuffer:4*1024*1024})).stdout;assert.equal(await readFile(join(directory,path),'utf8'),expected,`archive differs from exact target: ${path}`);}
const load=path=>import(pathToFileURL(join(directory,path)).href);
const {probeSchemaCompatibility}=await load('src/lib/schema-readiness.mjs');
const {claimPublicationLease}=await load('worker/publication-lease.mjs');
const {telegramPartDefinitions,deliverTelegramParts}=await load('worker/telegram-multipart.mjs');
const {telegramCarouselPartDefinitions,deliverTelegramCarousel}=await load('worker/telegram-carousel.mjs');
const source=await readFile(join(directory,'worker.mjs'),'utf8');
assert(!source.includes('AURORA_OUTBOUND_DISABLED'),'exact old worker unexpectedly supports the restore hold');
const transport=source.slice(source.indexOf('async function tg(method,'),source.indexOf('const sleep =',source.indexOf('async function tg(method,')));
const publish=source.slice(source.indexOf('async function publishTg('),source.indexOf('/** VK: расшифровываем',source.indexOf('async function publishTg(')));
const pool=new pg.Pool({connectionString:databaseUrl});
try{
 const readiness=await probeSchemaCompatibility(pool);assert(readiness.ready,'rollback code must retain all its catalog requirements');
 const unknown=(await pool.query("select id,project_id,schedule_revision from posts where verification_error_code='restored_delivery_unknown'")).rows;
 assert(unknown.length>0,'fresh restored quarantine fixture required');
 for(const post of unknown)for(const revision of [Number(post.schedule_revision)-1,Number(post.schedule_revision)]){
  assert.equal(await claimPublicationLease(pool,{postId:post.id,projectId:post.project_id,scheduleRevision:revision,leaseToken:'rollback-fixture',overdueCutoff:new Date(0)}),null);
 }
 const owner=(await pool.query('select id,created_by_user_id from projects order by id limit 1')).rows[0];
 const channel=(await pool.query("insert into channels(user_id,project_id,network,tg_chat_id,title) values($1,$2,'tg',$3,'rollback fake provider') returning *",[owner.created_by_user_id,owner.id,-Date.now()])).rows[0];
 const post=(await pool.query("insert into posts(user_id,project_id,channel_id,text,status,scheduled_at) values($1,$2,$3,'rollback fixture','scheduled',now()) returning id",[owner.created_by_user_id,owner.id,channel.id])).rows[0];
 let fakeProviderEffects=0;
 const queryPool={query:(sql,params)=>String(sql).includes('bot_delivery_events')?Promise.resolve({rows:[],rowCount:1}):pool.query(sql,params)};
 // Evaluate only pure definitions from the exact old worker. Never import/start
 // its consumers: it lacks the hold guard. All provider transport is injected.
 const oldPublish=vm.runInNewContext(`${transport}\n${publish}\npublishTg`,{pool:queryPool,fetch:async()=>{fakeProviderEffects++;return{status:200,json:async()=>{throw SyntaxError('synthetic_lost_ack');}};},AbortSignal,FormData,Blob,TOKEN:'123456:fixture',TELEGRAM_API_URL:'https://telegram.invalid',telegramSafeErrorDescription:String,classifyTelegramChannelFailure:()=>null,telegramPartDefinitions,deliverTelegramParts,telegramCarouselPartDefinitions,deliverTelegramCarousel,createHash,MEDIA_VIDEO_MAX_BYTES:1024,console});
 const first=await oldPublish(channel,post.id,'rollback fixture',null);
 const second=await oldPublish(channel,post.id,'rollback fixture',null);
 assert.equal(first.deliveryUnknown,false);assert.equal(second.deliveryUnknown,false);
 assert.equal(fakeProviderEffects,2,'old code should reproduce the confirmed duplicate regression on the newer schema');
 console.log(JSON.stringify({ok:true,rollbackTarget:sha,decision:'UNSAFE_FOR_WRITABLE_WEB_OR_WORKERS',catalogCompatible:true,forwardMigrations:readiness.forwardMigrations,restoredOldAndCurrentJobClaims:'denied',restoreHoldSupported:false,exactOldWorkerFakeEffectsAfterLostAck:fakeProviderEffects,realProviderCalls:0,oldConsumersStarted:false,reason:'SQL compatibility does not restore A1/A2/A3 protections; use a forward safety fix or a separately rehearsed patched rollback target'}));
}finally{await pool.end();}
