import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { reportRuntimeOperations, runtimeAiConfiguration } from "../../scripts/report-runtime-operations.mjs";
import { migrate } from "../../scripts/migrate.mjs";
const databaseUrl=process.env.MIGRATION_TEST_DATABASE_URL||"";
const target=new URL(databaseUrl);
if(!["localhost","127.0.0.1"].includes(target.hostname)||target.pathname!=="/aurora_operations_test")throw new Error("Disposable local aurora_operations_test required");
const pool=new pg.Pool({connectionString:databaseUrl,ssl:false,max:3});
const secret="CANARY_SECRET_DO_NOT_EXPORT_eyJhbGciOi_token";
const aiConfig={AI_SPEND_USER_DAILY_MICROUSD:"100",AI_SPEND_PROJECT_DAILY_MICROUSD:"100",AI_SPEND_GLOBAL_DAILY_MICROUSD:"100",AI_SPEND_USER_CONCURRENCY:"1",AI_SPEND_PROJECT_CONCURRENCY:"2",AI_SPEND_GLOBAL_CONCURRENCY:"3",AI_SPEND_TARIFFS_JSON:JSON.stringify({[secret]:{inputMicrousdPerMillionTokens:1,outputMicrousdPerMillionTokens:1}}),SECRET_API_KEY:secret};
let user=0,project=0,channel=0,post=0,site=0,destination=0,article=0;
const snapshot=(config:Record<string,string>=aiConfig)=>reportRuntimeOperations({databaseUrl,aiConfig:config});
beforeAll(async()=>{
 await pool.query("drop schema public cascade");await pool.query("create schema public");await pool.query(await readFile(new URL("../../db/schema.sql",import.meta.url),"utf8"));await migrate({env:{...process.env,DATABASE_URL:databaseUrl},logger:{log(){}}});
 user=Number((await pool.query("insert into users(email,name)values($1,$2)returning id",[secret+"@example.test",secret])).rows[0].id);
 project=Number((await pool.query("insert into projects(name,created_by_user_id)values($1,$2)returning id",[secret,user])).rows[0].id);
 await pool.query("insert into project_members(project_id,user_id,role)values($1,$2,'owner')",[project,user]);
 await pool.query("insert into user_project_preferences(user_id,selected_project_id)values($1,$2)",[user,project]);
 channel=Number((await pool.query("insert into channels(user_id,project_id,network,tg_chat_id,title,status,last_auth_error_code,last_auth_error_at)values($1,$2,'tg',-100777666,$3,'needs_reconnect',$3,now())returning id",[user,project,secret])).rows[0].id);
 post=Number((await pool.query("insert into posts(user_id,channel_id,text,status,last_error,provider_reconciliation_state)values($1,$2,$3,'quarantined',$3,'unresolved')returning id",[user,channel,secret])).rows[0].id);
 await pool.query("insert into publication_parts(post_id,part_index,part_type,payload_html,send_status,last_error_code)values($1,0,'text',$2,'unknown',$2)",[post,secret]);
 await pool.query("insert into telegram_update_deliveries(bot_id,update_id,part_index,payload_hash,send_status,receipt)values(777,888,0,$1,'unknown',$2::jsonb)",['a'.repeat(64),JSON.stringify({secret})]);
 await pool.query("insert into bot_client_inquiries(project_id,incoming_text,source_type,status,delivery_error_code)values($1,$2,'support','failed','delivery_unknown')",[project,secret]);
 site=Number((await pool.query("insert into sites(project_id,user_id,confirmed_domain,canonical_url,verification_token)values($1,$2,'incident.test','https://incident.test/',$3)returning id",[project,user,secret])).rows[0].id);
 destination=Number((await pool.query("insert into site_destinations(site_id,kind,base_url,credential_state,status)values($1,'site_hosted','https://incident.test/','not_required','active')returning id",[site])).rows[0].id);
 article=Number((await pool.query("insert into site_articles(site_id,project_id,user_id,article_type,origin,slug,status,title,body_markdown)values($1,$2,$3,'audience_answer','manual','incident','needs_review',$4,$4)returning id",[site,project,user,secret])).rows[0].id);
 await pool.query("insert into site_article_publications(article_id,destination_id,article_version,idempotency_key,status,outcome,reconcile_state,last_error_code)values($1,$2,1,'incident-publication','published_unverified','delivery_unknown','unresolved',$3)",[article,destination,secret]);
 const operation=Number((await pool.query("insert into publication_operations(user_id,draft_version,idempotency_key,fingerprint,text,scheduled_at,destination_ids)values($1,1,'incident-operation',$2,$3,now(),'[]')returning id",[user,'b'.repeat(64),secret])).rows[0].id);
 await pool.query("insert into publication_outbox(operation_id,post_id,status,next_attempt_at,last_error_code)values($1,$2,'failed',now()-interval '10 minutes',$3)",[operation,post,secret]);
 for(const status of ['reserved','failed'])await pool.query("insert into ai_spend_attempts(id,user_id,project_id,provider,model,status,reserved_microusd,tariff,input_token_bound,output_token_bound,lease_expires_at,finalized_at)values($1,$2,$3,$4,$4,$5,100,$6::jsonb,1,1,now()-interval '1 minute',case when $5='reserved' then null else now()end)",[randomUUID(),user,project,secret,status,JSON.stringify({secret})]);
 await pool.query("insert into media_storage_policy(id,user_max_bytes,project_max_bytes,global_max_bytes)values(1,4,4,4)");
 await pool.query("insert into media_assets(user_id,project_id,kind,file_name,mime_type,bytes,sha256,data,origin)values($1,$2,'image',$3,'image/png',4,$4,$5,'upload')",[user,project,secret,'c'.repeat(64),Buffer.from('test')]);
});
afterAll(async()=>pool.end());
describe('O04/O07 durable operational incident snapshot',()=>{
 it('reports failure/unknown delivery and due work without provider payloads or user identity',async()=>{
  const report=await snapshot();expect(report.readOnly).toBe(true);
  for(const group of [report.sections.outboxes,report.sections.durableQueueJobs])for(const value of Object.values(group))expect(value).toMatchObject({status:"available"});
  expect(report.sections.postDelivery).toMatchObject({status:'available',rows:[{quarantined:'1',unresolved_reconciliation:'1'}]});
  for(const key of ['publicationParts','botUpdateDelivery','audienceDelivery','siteDelivery'])expect(report.sections[key]).toMatchObject({status:'available',rows:[{unknown:'1'}]});
  expect(report.sections.connectionAuth).toMatchObject({rows:[{channel_access_unavailable:'1',channels_with_recent_auth_error:'1'}]});
  expect(report.sections.outboxes.publication_outbox).toMatchObject({status:'available',rows:[{waiting:'1',due:'1'}]});
  expect(Number(report.sections.outboxes.publication_outbox.rows[0].oldest_due_seconds)).toBeGreaterThanOrEqual(600);
  const output=JSON.stringify(report);for(const value of [secret,'@example.test','incident.test','secret','payload_html','last_error_code','provider_ref'])expect(output).not.toContain(value);
 });
 it('separates unknown cost from refundable usage and exposes exact supplied caps and storage limits',async()=>{
  const report=await snapshot();expect(report.sections.aiConfiguration).toMatchObject({status:'configured',caps:{USER_DAILY_MICROUSD:'100'},tariffEntries:1});
  expect(report.sections.aiSpend).toMatchObject({status:'available',rows:[{daily_accounted_microusd:'200',daily_failed_attempts:'1',reserved_attempts:'1',expired_reserved_attempts:'1',usage_unknown_attempts:'2',users_at_supplied_cap:'1',at_supplied_global_cap:true}]});
  expect(report.sections.mediaPolicy).toMatchObject({status:'available',rows:[{user_max_bytes:'4',project_max_bytes:'4',global_max_bytes:'4'}]});
  expect(report.sections.mediaUsage).toMatchObject({status:'available',rows:[{global_counter_bytes:'4',stored_asset_bytes:'4',at_global_policy_cap:true}]});
 });
 it('labels absent or malformed supplied configuration instead of claiming accepted thresholds',async()=>{
  const report=await snapshot({});expect(report.sections.aiConfiguration.status).toBe('unconfigured_or_invalid');
  expect(report.sections.aiSpend.rows[0]).toMatchObject({users_at_supplied_cap:null,projects_at_supplied_cap:null,at_supplied_global_cap:null});
  expect(runtimeAiConfiguration({AI_SPEND_TARIFFS_JSON:secret})).toMatchObject({status:'unconfigured_or_invalid',tariffEntries:0});
  expect(report.redisQueueState).toBe('not_observed');expect(report.oncallReceipt).toBe('not_observed');
 });
 it('labels a missing media policy without claiming that usage is below a nonexistent cap',async()=>{
  await pool.query("delete from media_storage_policy");
  try { const report=await snapshot();expect(report.sections.mediaPolicy.status).toBe('unconfigured');expect(report.sections.mediaUsage.rows[0]).toMatchObject({global_counter_bytes:'4',users_at_policy_cap:null,projects_at_policy_cap:null,at_global_policy_cap:null}); }
  finally { await pool.query("insert into media_storage_policy(id,user_max_bytes,project_max_bytes,global_max_bytes)values(1,4,4,4)"); }
 });
 it('does not mutate rows while observing the same durable incidents again',async()=>{
  const before=(await pool.query("select md5(string_agg(row_to_json(a)::text,'' order by id)) as hash from ai_spend_attempts a")).rows[0].hash;
  await snapshot();await snapshot();
  expect((await pool.query("select md5(string_agg(row_to_json(a)::text,'' order by id)) as hash from ai_spend_attempts a")).rows[0].hash).toBe(before);
  expect((await pool.query("select send_status from publication_parts where post_id=$1",[post])).rows[0].send_status).toBe('unknown');
 });
 it('distinguishes a synthetic resolved incident without erasing accumulated spend',async()=>{
  await pool.query("update posts set status='published',provider_reconciliation_state='confirmed' where id=$1",[post]);
  await pool.query("update publication_parts set send_status='sent' where post_id=$1",[post]);await pool.query("update telegram_update_deliveries set send_status='sent'");
  await pool.query("update bot_client_inquiries set delivery_error_code=null,status='sent'");await pool.query("update site_article_publications set outcome='success',status='published',reconcile_state='confirmed'");
  await pool.query("update publication_outbox set status='enqueued',enqueued_at=now()");await pool.query("update channels set status='active',last_auth_error_at=null,last_auth_error_code=null where id=$1",[channel]);
  await pool.query("update ai_spend_attempts set status='succeeded',finalized_at=now(),charged_microusd=10,input_tokens=1,output_tokens=1,usage_known=true");
  const report=await snapshot();for(const key of ['publicationParts','botUpdateDelivery','audienceDelivery','siteDelivery'])expect(report.sections[key].rows[0].unknown).toBe('0');
  expect(report.sections.outboxes.publication_outbox.rows[0].due).toBe('0');expect(report.sections.aiSpend.rows[0]).toMatchObject({daily_accounted_microusd:'20',usage_unknown_attempts:'0',at_supplied_global_cap:false});
 });
 it('enforces PostgreSQL read-only mode even if a relation would execute a write, and continues independent sections',async()=>{
  await pool.query("create table readonly_probe(n integer)");
  await pool.query("create function forbidden_report_write()returns text language plpgsql as $$begin insert into readonly_probe values(1);return 'quarantined';end$$");
  await pool.query("alter table posts rename to posts_fixture");
  try{
   await pool.query("create view posts as select forbidden_report_write() as status,provider_reconciliation_state,scheduled_at from posts_fixture");
   const report=await snapshot();expect(report.sections.postDelivery).toEqual({status:'unavailable',reason:'25006'});expect(report.sections.aiSpend.status).toBe('available');
   expect(Number((await pool.query("select count(*) from readonly_probe")).rows[0].count)).toBe(0);
  }finally{await pool.query("drop view if exists posts");await pool.query("alter table posts_fixture rename to posts");}
 });
 it('reports a missing required table as unavailable, without turning it into a zero',async()=>{
  await pool.query("alter table telegram_update_deliveries rename to receipt_fixture");
  try{const report=await snapshot();expect(report.sections.botUpdateDelivery).toEqual({status:'unavailable',reason:'42P01'});expect(report.sections.aiSpend.status).toBe('available');}
  finally{await pool.query("alter table receipt_fixture rename to telegram_update_deliveries");}
 });
});
