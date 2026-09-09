import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {migrate} from './migrate.mjs';
import {cleanupUnusedMedia} from '../src/lib/media-retention.mjs';
import {cleanupMediaObjectOrphans,withJournaledMediaObject} from '../src/lib/media-storage.mjs';
const databaseUrl=process.env.MIGRATION_TEST_DATABASE_URL;const url=new URL(databaseUrl||'postgres://invalid/invalid');
assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname)&&url.pathname==='/aurora_media_lifecycle_test','explicit disposable lifecycle database required');
assert(!process.env.DATABASE_URL,'application DATABASE_URL must not be inherited');
const pool=new pg.Pool({connectionString:databaseUrl,max:5});
try{
 await pool.query('drop schema public cascade');await pool.query('create schema public');await pool.query(await readFile(new URL('../db/schema.sql',import.meta.url),'utf8'));
 await migrate({env:{DATABASE_URL:databaseUrl},logger:{log(){}}});
 await pool.query('insert into media_storage_policy(id,user_max_bytes,project_max_bytes,global_max_bytes) values(1,65536,65536,65536)');
 const user=(await pool.query("insert into users(email,name) values('lifecycle@example.invalid','fixture') returning id")).rows[0].id;
 const project=(await pool.query("insert into projects(name,created_by_user_id) values('lifecycle',$1) returning id",[user])).rows[0].id;
 const channel=(await pool.query("insert into channels(user_id,project_id,network,tg_chat_id,title) values($1,$2,'tg',-987,'fixture') returning id",[user,project])).rows[0].id;
 const data=Buffer.from('synthetic-media-fixture');const sha=createHash('sha256').update(data).digest('hex');
 async function asset(object=null){return (await pool.query(`insert into media_assets(user_id,project_id,kind,file_name,mime_type,bytes,data,sha256,storage_backend,object_key,created_at)
 values($1,$2,'image','fixture.png','image/png',$3,$4,$5,$6,$7,now()-interval '30 days') returning id`,[user,project,data.length,object?null:data,sha,object?'object':'postgres',object?.key||null])).rows[0].id;}
 const ids=[];for(let i=0;i<6;i++)ids.push(await asset());
 const draft=(await pool.query("insert into drafts(user_id,project_id,client_key,media,text) values($1,$2,'lifecycle',$3,$4) returning id",[user,project,JSON.stringify({assetId:String(ids[0])}),`image /api/media/assets/${ids[5]}`])).rows[0].id;
 await pool.query("insert into draft_revisions(project_id,draft_id,draft_version,author_user_id,content_hash,snapshot) values($1,$2,1,$3,$4,$5)",[project,draft,user,'a'.repeat(64),JSON.stringify({media:{kind:'carousel',items:[{assetId:ids[1]}]}})]);
 await pool.query("insert into posts(user_id,project_id,channel_id,status,text,media,published_at) values($1,$2,$3,'published','fixture',$4,now())",[user,project,channel,JSON.stringify({assetId:ids[2]})]);
 await pool.query("insert into media_generations(user_id,project_id,kind,status,prompt,model,aspect_ratio,provider_request_key,output_asset_id) values($1,$2,'image','ready','fixture','fixture','1:1','fixture',$3)",[user,project,ids[3]]);
 const objects=new Map();const put=async({key})=>{objects.set(key,data);return {key,etag:'fixture'};};
 const input={pool,projectId:Number(project),sha256:sha,extension:'png',mimeType:'image/png',body:data,put};
 const objectId=await withJournaledMediaObject(input,asset);
 const cutoff=new Date(Date.now()-86400_000).toISOString();
 const dry=await cleanupUnusedMedia({pool,createdBefore:cutoff});
 assert.deepEqual(dry.unusedIds.sort(),[String(ids[4]),String(objectId)].sort());assert.equal(dry.deleted,0);
 assert.equal(Number((await pool.query('select count(*) as n from media_assets')).rows[0].n),7);
 const before=Number((await pool.query("select bytes_used from media_storage_usage where scope='global'")).rows[0].bytes_used);
 const applied=await cleanupUnusedMedia({pool,createdBefore:cutoff,apply:true});assert.equal(applied.deleted,2);
 assert.equal(Number((await pool.query("select bytes_used from media_storage_usage where scope='global'")).rows[0].bytes_used),before-2*data.length);
 assert.equal((await cleanupUnusedMedia({pool,createdBefore:cutoff,apply:true})).deleted,0);
 // Journal covers lost PUT acknowledgement, database quota/transaction failure,
 // and a completed-generation no-op. No real object provider is ever called.
 await assert.rejects(withJournaledMediaObject({...input,put:async(args)=>{await put(args);throw Error('lost_receipt');}},asset),/lost_receipt/);
 await assert.rejects(withJournaledMediaObject(input,async()=>{throw Error('quota_rejected');}),/quota_rejected/);
 await withJournaledMediaObject(input,async()=>{});
 const successful=await withJournaledMediaObject(input,asset);
 let release;const gate=new Promise(r=>{release=r;});let entered;const started=new Promise(r=>{entered=r;});
 const active=withJournaledMediaObject(input,async()=>{entered();await gate;});await started;
 await pool.query("update media_object_orphans set next_attempt_at=now() where deleted_at is null");
 const removed=[];const remove=async key=>{removed.push(key);objects.delete(key);};
 const first=await cleanupMediaObjectOrphans({pool,remove});assert.equal(first.failed,0);assert.equal(first.deleted,4);assert.equal(first.retained,2);
 release();await active;
 const second=await cleanupMediaObjectOrphans({pool,remove});assert.equal(second.deleted,1);
 assert.equal(objects.size,1,'only referenced successful object remains');
 const successfulKey=(await pool.query('select object_key from media_assets where id=$1',[successful])).rows[0].object_key;assert(objects.has(successfulKey));
 // Prove JSON writers cannot race deletion: cleanup must wait for their table
 // lock and then observe the newly committed draft reference.
 const raceId=await asset();const writer=await pool.connect();
 const cleaner=new pg.Pool({connectionString:databaseUrl,application_name:'aurora_media_cleanup_race',max:1});
 await writer.query('begin');await writer.query("insert into drafts(user_id,project_id,client_key,media) values($1,$2,'race',$3)",[user,project,JSON.stringify({assetId:raceId})]);
 const cleanup=cleanupUnusedMedia({pool:cleaner,createdBefore:cutoff,apply:true});
 let observedWait=false;
 for(let attempt=0;attempt<100;attempt++){
  observedWait=(await pool.query("select 1 from pg_stat_activity where application_name='aurora_media_cleanup_race' and wait_event_type='Lock'")).rowCount>0;
  if(observedWait)break;await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert(observedWait,'cleanup must serialize behind the active JSON reference writer');
 await writer.query('commit');writer.release();
 const raced=await cleanup;await cleaner.end();assert(raced.protectedIds.includes(String(raceId)));
 assert.equal((await pool.query('select 1 from media_assets where id=$1',[raceId])).rowCount,1);
 console.log(JSON.stringify({ok:true,protected:['draft_json','approved_revision_snapshot','published_post','generation_fk','embedded_url'],unusedDeleted:2,quotaRelease:true,objectReceiptLoss:true,objectTransactionFailure:true,activeUploadLock:true,concurrentJsonReferenceProtected:true,objectDeletes:removed.length,referencedObjectRetained:true,providerCalls:0,retention:applied}));
}finally{await pool.end();}
