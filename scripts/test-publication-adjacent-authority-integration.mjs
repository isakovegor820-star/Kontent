import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {migrate} from './migrate.mjs';
const load=name=>import(process.env.ADMISSION_WORKER_DIRECTORY?pathToFileURL(`${process.env.ADMISSION_WORKER_DIRECTORY}/${name}`).href:new URL(`../worker/${name}`,import.meta.url).href);
const {publishSiteArticle}=await load('site-articles-worker.mjs');
const {processPublicationExtraOperation}=await load('publication-extra-worker.mjs');
const target=new URL(process.env.MIGRATION_TEST_DATABASE_URL||'postgres://invalid/invalid');assert(['127.0.0.1','localhost','[::1]'].includes(target.hostname)&&target.pathname==='/aurora_adjacent_authority_test');assert(!process.env.DATABASE_URL);
const pool=new pg.Pool({connectionString:target.href,max:5});let scenarios=0;const failures=[];
try{
 await pool.query('drop schema public cascade');await pool.query('create schema public');await pool.query(await readFile(new URL('../db/schema.sql',import.meta.url),'utf8'));await migrate({env:{DATABASE_URL:target.href},logger:{log(){}}});
 const actor=(await pool.query("insert into users(email) values('actor@adjacent.invalid') returning id")).rows[0].id;
 const author=(await pool.query("insert into users(email) values('author@adjacent.invalid') returning id")).rows[0].id;
 const project=(await pool.query("insert into projects(name,created_by_user_id) values('fixture',$1) returning id",[actor])).rows[0].id;
 await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'publisher'),($1,$3,'owner')",[project,actor,author]);
 const channel=(await pool.query("insert into channels(user_id,project_id,network,tg_chat_id,title) values($1,$2,'tg',-8787654,'fixture') returning id",[author,project])).rows[0].id;
 const site=(await pool.query("insert into sites(project_id,user_id,confirmed_domain,canonical_url,verification_token,verification_state,hosted_slug) values($1,$2,'adjacent.invalid','https://adjacent.invalid','synthetic-verification-token','verified','fixture') returning id",[project,author])).rows[0].id;
 const destination=(await pool.query("insert into site_destinations(site_id,kind,base_url,credential_state,status) values($1,'site_hosted','https://adjacent.invalid','not_required','active') returning id",[site])).rows[0].id;
 const mutations={valid:['select 1',[]],archive:["update projects set is_archived=true where id=$1",[project]],revoke:["update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2",[project,actor]],demote:["update project_members set role='author' where project_id=$1 and user_id=$2",[project,actor]],blocked:["update users set blocked_at=now() where id=$1",[actor]]};
 async function restore(){await pool.query('update projects set is_archived=false where id=$1',[project]);await pool.query("update project_members set role='publisher',status='active',revoked_at=null where project_id=$1 and user_id=$2",[project,actor]);await pool.query('update users set blocked_at=null where id=$1',[actor]);await pool.query("update channels set status='active',tg_chat_id=-8787654 where id=$1",[channel]);await pool.query("update site_destinations set status='active',base_url='https://adjacent.invalid' where id=$1",[destination]);await pool.query("update sites set status='active',verification_state='verified' where id=$1",[site]);}
 async function test(name,fn){try{await restore();await fn();scenarios++;console.log(`PASS ${name}`);}catch(error){failures.push(name);console.error(`FAIL ${name}: ${error.message}`);}}
 const mutationPool=(needle,mutation)=>({connect:()=>pool.connect(),query:async(sql,params)=>{if(String(sql).includes(needle)){await pool.query(...mutation);}return pool.query(sql,params);}});
 for(const [name,mutation]of Object.entries({...mutations,channel_rebound:["update channels set tg_chat_id=tg_chat_id-100 where id=$1",[channel]],channel_revoked:["update channels set status='revoked' where id=$1",[channel]]}))for(const timing of ['queued','before_provider'])await test(`extra ${name} ${timing}`,async()=>{
  const post=(await pool.query("insert into posts(project_id,user_id,channel_id,text,status,scheduled_at,tg_message_id) values($1,$2,$3,'fixture','published',now(),44) returning id",[project,author,channel])).rows[0].id;
  const operation=(await pool.query("insert into publication_extra_operations(project_id,post_id,channel_id,kind,sequence_index,idempotency_key,fingerprint,request_snapshot,requested_by_user_id) values($1,$2,$3,'pin',30,$4,$5,'{\"providerId\":\"tg\"}',$6) returning id",[project,post,channel,`fixture-${post}`,'a'.repeat(64),actor])).rows[0].id;
  let calls=0;const runPool=timing==='queued'?pool:mutationPool('set provider_started_at = coalesce',mutation);if(timing==='queued')await pool.query(...mutation);
  await processPublicationExtraOperation({pool:runPool,operationId:Number(operation),projectId:Number(project),fingerprint:'a'.repeat(64),telegramRequest:async()=>{calls++;return{ok:true,result:true};},finalAttempt:true}).catch(()=>{});
  assert.equal(calls,(name==='valid'||(name==='channel_rebound'&&timing==='queued'))?1:0,'no extra provider request with revoked current authority');
 });
 for(const [name,mutation]of Object.entries({...mutations,destination_rebound:["update site_destinations set base_url='https://replacement.invalid' where id=$1",[destination]],destination_revoked:["update site_destinations set status='revoked' where id=$1",[destination]],site_unverified:["update sites set verification_state='revoked' where id=$1",[site]]}))for(const timing of ['queued','before_provider'])await test(`site ${name} ${timing}`,async()=>{
  const article=(await pool.query("insert into site_articles(site_id,project_id,user_id,article_type,origin,slug,status,title,body_markdown,body_html,approved_by,approved_version,approved_at) values($1,$2,$3,'audience_answer','manual',$4,'approved','fixture','fixture','<p>fixture</p>',$3,1,now()) returning id",[site,project,author,`fixture-${scenarios}-${failures.length}`])).rows[0].id;
  const publication=(await pool.query("insert into site_article_publications(article_id,destination_id,article_version,idempotency_key,requested_by_user_id) values($1,$2,1,$3,$4) returning id",[article,destination,`fixture-${article}`,actor])).rows[0].id;
  let calls=0;const runPool=timing==='queued'?pool:mutationPool("update site_articles set status = 'publishing'",mutation);if(timing==='queued')await pool.query(...mutation);
  await publishSiteArticle(runPool,{publicationId:Number(publication)},{adapters:{site_hosted:{publish:async()=>{calls++;return{ok:true,outcome:'success',providerRef:{slug:'fixture'},publishedUrl:'https://adjacent.invalid/fixture'};}}}});
  assert.equal(calls,(name==='valid'||(name==='destination_rebound'&&timing==='queued'))?1:0,'no Sites provider request with revoked current authority');
 });
 await test('Sites pending legacy publisher is unknown and must not infer author/approver',async()=>{
  const article=(await pool.query("insert into site_articles(site_id,project_id,user_id,article_type,origin,slug,status,title,body_markdown,approved_by,approved_version,approved_at) values($1,$2,$3,'audience_answer','manual','legacy','approved','fixture','fixture',$3,1,now()) returning id",[site,project,author])).rows[0].id;
  const publication=(await pool.query("insert into site_article_publications(article_id,destination_id,article_version,idempotency_key) values($1,$2,1,'fixture-legacy') returning id",[article,destination])).rows[0].id;let calls=0;
  await publishSiteArticle(pool,{publicationId:Number(publication)},{adapters:{site_hosted:{publish:async()=>{calls++;return{ok:true,outcome:'success',providerRef:{slug:'legacy'}};}}}});assert.equal(calls,0);
 });
 console.log(JSON.stringify({ok:failures.length===0,scenarios,failures,realProviderCalls:0}));assert.equal(failures.length,0);
}finally{await pool.end();}
