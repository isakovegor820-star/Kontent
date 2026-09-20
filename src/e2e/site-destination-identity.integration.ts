import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate.mjs';
import type {SiteRow} from '@/lib/sites/service';
import type {SiteDestinationAdapter,SiteDestinationKind} from '@/lib/site-destinations/index.mjs';
import {destinationRuntime} from '@/lib/site-destinations/index.mjs';
import {publishSiteArticle} from '../../worker/site-articles-worker.mjs';
const {upsertSiteDestination}=(process.env.SITE_DESTINATION_SOURCE?await import(process.env.SITE_DESTINATION_SOURCE):await import('@/lib/sites/destinations-service')) as typeof import('@/lib/sites/destinations-service');
const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL||'postgres://invalid/invalid');
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!='/aurora_destination_identity_test'||process.env.DATABASE_URL)throw Error('Explicit disposable aurora_destination_identity_test required');
const pool=new pg.Pool({connectionString:url.href,max:6});
const oldEnv={TOKENS_MASTER_KEY:process.env.TOKENS_MASTER_KEY,TOKENS_KEY_ID:process.env.TOKENS_KEY_ID,TOKENS_OLD_KEYS:process.env.TOKENS_OLD_KEYS};let user=0,other=0,project=0;let index=0;
const adapters=(accountId:number)=>({wordpress:{verify:async()=>({ok:true,account:{id:accountId}})}} as unknown as Readonly<Record<SiteDestinationKind,SiteDestinationAdapter>>);
beforeAll(async()=>{
 process.env.TOKENS_MASTER_KEY='destination-identity-synthetic-test-key';process.env.TOKENS_KEY_ID='fixture';process.env.TOKENS_OLD_KEYS='{}';
 await pool.query('drop schema public cascade');await pool.query('create schema public');await pool.query(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'));await migrate({env:{DATABASE_URL:url.href},logger:{log(){}}});
 const users=(await pool.query("insert into users(email) values('destination-owner@example.invalid'),('second-owner@example.invalid') returning id")).rows;user=Number(users[0].id);other=Number(users[1].id);
 project=Number((await pool.query("insert into projects(name,created_by_user_id) values('fixture',$1) returning id",[user])).rows[0].id);await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'owner'),($1,$3,'owner')",[project,user,other]);
});
afterAll(async()=>{await pool.end();for(const[key,value]of Object.entries(oldEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
async function fixture(status='published'){
 const site=(await pool.query("insert into sites(project_id,user_id,confirmed_domain,canonical_url,verification_token,verification_state,hosted_slug) values($1,$2,$3||'.invalid','https://'||$3||'.invalid','synthetic-verification-token','verified',$3) returning *",[project,user,`fixture-${++index}`])).rows[0] as SiteRow;
 const first=await upsertSiteDestination(pool,{site,userId:user,kind:'wordpress',baseUrl:'https://old-wp.invalid/blog/',credentials:{username:'fixture',appPassword:'synthetic-password'},adapters:adapters(71)});
 const article=Number((await pool.query("insert into site_articles(site_id,project_id,user_id,article_type,origin,slug,status,title,body_markdown,body_html,approved_by,approved_version,approved_at) values($1,$2,$3,'audience_answer','manual','fixture','published','fixture','fixture','<p>fixture</p>',$3,1,now()) returning id",[site.id,project,user])).rows[0].id);
 const publication=Number((await pool.query("insert into site_article_publications(article_id,destination_id,article_version,idempotency_key,status,outcome,reconcile_state,provider_ref,completed_at,requested_by_user_id) values($1,$2,1,$3,$4,$5,$6,'{\"id\":911}',now(),$7) returning id",[article,first.row.id,`fixture-${article}`,status,status==='published'?'success':status==='published_unverified'?'delivery_unknown':null,status==='published'?'confirmed':'none',user])).rows[0].id);
 return{site,destination:first.row,article,publication};
}
async function reconnect(row:Awaited<ReturnType<typeof fixture>>,baseUrl='https://new-wp.invalid/blog/',accountId=71,userId=user,database=pool){return upsertSiteDestination(database,{site:row.site,userId,kind:'wordpress',baseUrl,credentials:{username:'fixture-renamed',appPassword:'synthetic-rotated-password'},adapters:adapters(accountId)});}
it('blocks host replacement before an old numeric receipt could update a different WordPress post',async()=>{
 const row=await fixture();let blocked=false;try{await reconnect(row);}catch(error){blocked=(error as {code?:string}).code==='destination_identity_in_use';}
 let wrongTarget=0;
 if(!blocked){const operation=Number((await pool.query("insert into site_article_publications(article_id,destination_id,article_version,idempotency_key,action,requested_by_user_id) values($1,$2,1,$3,'update',$4) returning id",[row.article,row.destination.id,`update-${row.article}`,user])).rows[0].id);
 await publishSiteArticle(pool,{publicationId:operation},{adapters:{wordpress:{update:async(destination:{baseUrl:string},ref:{id:number})=>{if(destination.baseUrl.startsWith('https://new-wp.invalid')&&ref.id===911)wrongTarget++;return{ok:true,outcome:'success',providerRef:ref};}}}});}
 expect(wrongTarget).toBe(0);expect(blocked).toBe(true);expect((await pool.query('select base_url from site_destinations where id=$1',[row.destination.id])).rows[0].base_url).toBe('https://old-wp.invalid/blog/');
});
it.each(['pending','publishing','published_unverified'])('holds replacement while %s operation exists',async(status)=>{const row=await fixture(status);await expect(reconnect(row)).rejects.toMatchObject({code:'destination_identity_in_use',status:409});});
it('blocks a different provider account and unknown legacy identity even on the same host',async()=>{const row=await fixture();await expect(reconnect(row,'https://old-wp.invalid/blog/',72)).rejects.toMatchObject({code:'destination_identity_in_use'});await pool.query("update site_destinations set settings='{}' where id=$1",[row.destination.id]);await expect(reconnect(row,'https://old-wp.invalid/blog/',71)).rejects.toMatchObject({code:'destination_identity_in_use'});});
it('allows verified same-host same-account credential rotation by another owner with a stable worker decryption context',async()=>{const row=await fixture();const rotated=await reconnect(row,'https://old-wp.invalid/blog',71,other);expect(Number(rotated.row.id)).toBe(Number(row.destination.id));expect(destinationRuntime(rotated.row,{userId:user}).credentials).toMatchObject({username:'fixture-renamed',appPassword:'synthetic-rotated-password'});});
it('allows replacement after every old destination publication is confirmed unpublished',async()=>{const row=await fixture();await pool.query("insert into site_article_publications(article_id,destination_id,article_version,idempotency_key,action,status,outcome,reconcile_state,provider_ref,completed_at,requested_by_user_id) values($1,$2,1,$3,'unpublish','published','success','confirmed','{\"id\":911}',clock_timestamp(),$4)",[row.article,row.destination.id,`retire-${row.article}`,user]);expect((await reconnect(row)).row.base_url).toBe('https://new-wp.invalid/blog/');});
it('serializes replacement with a concurrent publication receipt insert',async()=>{const row=await fixture();await pool.query('delete from site_article_publications where id=$1',[row.publication]);const tx=await pool.connect();await tx.query('begin');await tx.query("insert into site_article_publications(article_id,destination_id,article_version,idempotency_key,status,requested_by_user_id) values($1,$2,1,$3,'pending',$4)",[row.article,row.destination.id,`race-${row.article}`,user]);let settled=false,runnerPid=0;
 const observed={query:pool.query.bind(pool),connect:async()=>{const client=await pool.connect();runnerPid=Number((await client.query('select pg_backend_pid() as pid')).rows[0].pid);return client;}} as unknown as typeof pool;
 const replacement=reconnect(row,'https://new-wp.invalid/blog/',71,user,observed).then(value=>{settled=true;return{value};},error=>{settled=true;return{error};});
 let waited=false;const deadline=Date.now()+2000;while(!settled&&Date.now()<deadline){if(runnerPid){const state=(await pool.query('select wait_event_type from pg_stat_activity where pid=$1',[runnerPid])).rows[0];if(state?.wait_event_type==='Lock'){waited=true;break;}}await new Promise(resolve=>setTimeout(resolve,10));}
 await tx.query('commit');tx.release();expect(await replacement).toMatchObject({error:{code:'destination_identity_in_use'}});expect(waited).toBe(true);});
