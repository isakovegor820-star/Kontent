import {execFileSync} from 'node:child_process';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {NextRequest} from 'next/server';
import {beforeAll,afterAll,beforeEach,it,expect,vi} from 'vitest';
const scope=new AsyncLocalStorage<Headers>();
const mocks=vi.hoisted(()=>({pool:vi.fn(),user:vi.fn(),fetch:vi.fn(),enqueue:vi.fn()}));
vi.mock('next/headers',()=>({headers:async()=>scope.getStore()??new Headers()}));
vi.mock('@/lib/db',()=>({getPool:mocks.pool}));vi.mock('@/lib/session',()=>({getSessionUser:mocks.user}));
vi.mock('@/lib/queue',()=>({getStatsQueue:()=>({add:mocks.enqueue})}));
vi.mock('@/lib/safe-http.mjs',()=>({fetchPublicText:mocks.fetch}));
import {GET,POST} from '@/app/api/rss/route';
import {GET as catalog} from '@/app/api/rss/catalog/route';
import {POST as refresh} from '@/app/api/rss/refresh/route';
import {POST as bootstrap} from '@/app/api/rss/bootstrap/route';
import {listPublicLegalRssSources} from '@/lib/rss-catalog';
import {collectRssPipeline} from '../../worker/rss-pipeline.mjs';
import {planSiteArticles} from '../../worker/site-articles-worker.mjs';
import {migrate} from '../../scripts/migrate.mjs';
const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL||'http://invalid');
if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!='/aurora_rss_project_test')throw new Error('Requires disposable aurora_rss_project_test');
const pool=new pg.Pool({connectionString:url.href,max:4});let user=0,a=0,b=0,ca=0,cb=0,fb=0,site=0;
const feedUrl='https://example.test/private-b.xml';
const xml=()=>new Response('<rss><channel><title>Fixture</title><item><guid>fresh-'+crypto.randomUUID()+'</guid><title>Изменения законодательства</title><description>N18_FRESH_RSS_CANARY</description><link>https://example.test/item</link></item></channel></rss>',{headers:{'content-type':'application/rss+xml'}});
function request(path:string,method='GET',body?:unknown){return new NextRequest('http://localhost'+path,{method,headers:{origin:'http://localhost','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});}
function tab<T>(project:number,run:()=>Promise<T>){return scope.run(new Headers({'x-aurora-project-id':String(project)}),run);}
beforeAll(async()=>{
 await pool.query('drop schema public cascade');await pool.query('create schema public');await pool.query(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'));await migrate({env:{...process.env,DATABASE_URL:url.href},logger:{log(){}}});
 user=Number((await pool.query("insert into users(email)values('rss-project@example.test')returning id")).rows[0].id);
 [a,b]=(await pool.query("insert into projects(name,created_by_user_id)values('A',$1),('B',$1)returning id",[user])).rows.map(r=>Number(r.id));
 await pool.query("insert into project_members(project_id,user_id,role)values($1,$3,'owner'),($2,$3,'owner')",[a,b,user]);await pool.query('insert into user_project_preferences(user_id,selected_project_id)values($1,$2)',[user,b]);
 [ca,cb]=(await pool.query("insert into channels(user_id,project_id,network,tg_chat_id,title)values($1,$2,'tg',-100411,'A'),($1,$3,'tg',-100422,'B_FRESH_CHANNEL_CANARY')returning id",[user,a,b])).rows.map(r=>Number(r.id));
 site=Number((await pool.query("insert into sites(project_id,user_id,confirmed_domain,canonical_url,verification_token)values($1,$2,'rss.example.test','https://rss.example.test','synthetic-verification-rss')returning id",[a,user])).rows[0].id);
 const profile=Number((await pool.query('insert into site_profiles(site_id,topics)values($1,$2::jsonb)returning id',[site,JSON.stringify([{key:'законодательства'}])])).rows[0].id);await pool.query('update sites set latest_profile_id=$2 where id=$1',[site,profile]);mocks.pool.mockReturnValue(pool);
});
beforeEach(async()=>{mocks.user.mockResolvedValue({id:user});mocks.enqueue.mockReset();mocks.fetch.mockReset().mockImplementation(async()=>xml());await pool.query("update project_members set status='active',revoked_at=null where user_id=$1",[user]);await pool.query('update projects set is_archived=false where id=any($1)',[[a,b]]);await pool.query('delete from site_articles where site_id=$1',[site]);await pool.query('delete from rss_feeds'); fb=Number((await pool.query("insert into rss_feeds(user_id,channel_id,url,title,is_active,source_kind,project_id)values($1,$2,$3,'B_FRESH_FEED_CANARY',true,'legal_opportunity',$4)returning id",[user,cb,feedUrl,b])).rows[0].id);
 await pool.query("insert into rss_feeds(user_id,channel_id,url,title,is_active,source_kind,project_id)values($1,$2,'https://example.test/a.xml','A feed',true,'legal_opportunity',$3)",[user,ca,a]);
 await pool.query("insert into rss_items(feed_id,guid,title,summary,link,published_at)select id,'a-original','Изменения законодательства','A_SITE_SOURCE_CANARY','https://example.test/a',now() from rss_feeds where channel_id=$1",[ca]);
 await pool.query("insert into rss_items(feed_id,guid,title,summary,link,published_at)values($1,'b-original','Изменения законодательства','B_SITE_SOURCE_CANARY','https://example.test/b',now())",[fb]);
});
afterAll(async()=>pool.end());
it('GET honors tab A although shared preference is B and reveals no B feed',async()=>{const response=await tab(a,()=>GET(request('/api/rss')));expect(response.status).toBe(200);expect(JSON.stringify(await response.json())).not.toContain('B_FRESH');});
it('revoked historical connector cannot read feeds or personalized catalog',async()=>{await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2",[b,user]);expect((await tab(b,()=>GET(request('/api/rss')))).status).toBe(403);expect((await tab(b,()=>catalog(request('/api/rss/catalog?channelId='+cb)))).status).toBe(403);});
it('cross-project channel cannot create a feed or reveal catalog context',async()=>{expect((await tab(a,()=>POST(request('/api/rss','POST',{channelId:cb,url:'https://example.test/foreign.xml'})))).status).toBe(422);expect((await tab(a,()=>catalog(request('/api/rss/catalog?channelId='+cb)))).status).toBe(404);expect(mocks.fetch).not.toHaveBeenCalled();});
it('same user URL collision cannot move B feed into A',async()=>{const response=await tab(a,()=>POST(request('/api/rss','POST',{channelId:ca,url:feedUrl})));expect(response.status).toBe(200);expect((await pool.query('select project_id from rss_feeds where url=$1 order by project_id',[feedUrl])).rows.map(r=>Number(r.project_id))).toEqual([a,b]);expect(Number((await pool.query('select channel_id from rss_feeds where id=$1',[fb])).rows[0].channel_id)).toBe(cb);});
it('lawful create succeeds but committed revoke during feed fetch prevents save',async()=>{const good=await tab(a,()=>POST(request('/api/rss','POST',{channelId:ca,url:'https://example.test/allowed.xml'})));expect(good.status).toBe(200);mocks.fetch.mockImplementationOnce(async()=>{await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2",[a,user]);return xml();});expect((await tab(a,()=>POST(request('/api/rss','POST',{channelId:ca,url:'https://example.test/revoked-during.xml'})))).status).toBe(403);expect((await pool.query("select id from rss_feeds where url='https://example.test/revoked-during.xml'")).rowCount).toBe(0);});
it('manual refresh binds queue work to project and refuses revoked/foreign targets',async()=>{expect((await tab(a,()=>refresh(request('/api/rss/refresh','POST',{})))).status).toBe(200);expect(mocks.enqueue.mock.calls[0][1]).toMatchObject({userId:user,projectId:a,channelId:null});mocks.enqueue.mockClear();expect((await tab(a,()=>refresh(request('/api/rss/refresh','POST',{channelId:cb})))).status).toBe(422);await pool.query('update projects set is_archived=true where id=$1',[a]);expect((await tab(a,()=>refresh(request('/api/rss/refresh','POST',{})))).status).toBe(403);expect(mocks.enqueue).not.toHaveBeenCalled();});
it('identical catalog URLs can coexist in two projects without moving existing feeds',async()=>{
 const first=await tab(b,()=>bootstrap(request('/api/rss/bootstrap','POST',{channelId:cb})));expect(first.status).toBe(200);
 const old=(await pool.query("select id,channel_id,project_id from rss_feeds where project_id=$1 order by id",[b])).rows;
 const second=await tab(a,()=>bootstrap(request('/api/rss/bootstrap','POST',{channelId:ca})));expect(second.status).toBe(200);
 expect((await pool.query("select id,channel_id,project_id from rss_feeds where project_id=$1 order by id",[b])).rows).toEqual(old);
 for(const source of listPublicLegalRssSources())expect((await pool.query('select project_id from rss_feeds where url=$1 order by project_id',[source.url])).rows.map(r=>Number(r.project_id))).toEqual([a,b]);
});
it('actual RSS collector processes only queued project and ignores revoked membership',async()=>{const fetched:string[]=[];const run=()=>collectRssPipeline({pool,userId:user,projectId:a,fetchFn:async(url:string)=>{fetched.push(url);return xml();},enqueuePost:vi.fn(),logger:{log(){},error(){}}});await run();expect(fetched).not.toContain(feedUrl);expect(fetched).toContain('https://example.test/a.xml');fetched.length=0;await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2",[a,user]);await run();expect(fetched).toEqual([]);});
it('collector drops fresh response after permission revoke before persistence',async()=>{const timeBefore=(await pool.query('select last_fetched_at from rss_feeds where channel_id=$1',[ca])).rows;const before=Number((await pool.query('select count(*) from rss_items')).rows[0].count);await collectRssPipeline({pool,userId:user,channelId:ca,projectId:a,fetchFn:async()=>{await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2",[a,user]);return xml();},enqueuePost:vi.fn(),logger:{log(){},error(){}}});expect(Number((await pool.query('select count(*) from rss_items')).rows[0].count)).toBe(before);expect((await pool.query('select last_fetched_at from rss_feeds where channel_id=$1',[ca])).rows).toEqual(timeBefore);});
it('Sites planner never imports another project RSS source and stops after requester revoke',async()=>{await planSiteArticles(pool,{siteId:site,requestedByUserId:user});const planned=JSON.stringify((await pool.query('select source_ref from site_articles where site_id=$1',[site])).rows);expect(planned).not.toContain('B_SITE_SOURCE_CANARY');expect(planned).toContain('A_SITE_SOURCE_CANARY');await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2",[a,user]);expect(await planSiteArticles(pool,{siteId:site,requestedByUserId:user})).toMatchObject({planned:0,reason:'project_access_denied'});});
it('current author creates and collects a feed on a project channel connected by another user',async()=>{
 const author=Number((await pool.query("insert into users(email)values('rss-author@example.test')returning id")).rows[0].id);
 await pool.query("insert into project_members(project_id,user_id,role)values($1,$2,'author')",[a,author]);mocks.user.mockResolvedValue({id:author});
 const response=await tab(a,()=>POST(request('/api/rss','POST',{channelId:ca,url:'https://example.test/author.xml'})));expect(response.status).toBe(200);
 const id=(await response.json()).id;await pool.query("update rss_feeds set is_active=true,source_kind='legal_opportunity' where id=$1",[id]);
 const fetched=vi.fn(async()=>xml());await collectRssPipeline({pool,userId:author,projectId:a,fetchFn:fetched,enqueuePost:vi.fn(),logger:{log(){},error(){}}});expect(fetched).toHaveBeenCalledOnce();
 expect(JSON.stringify(await (await tab(a,()=>GET(request('/api/rss')))).json())).toContain('author.xml');
});
it('bootstrap succeeds in the current project and queues its explicit identity',async()=>{
 const response=await tab(a,()=>bootstrap(request('/api/rss/bootstrap','POST',{channelId:ca})));expect(response.status).toBe(200);const body=await response.json();expect(body.connected).toHaveLength(listPublicLegalRssSources().length);expect(mocks.enqueue.mock.calls[0][1]).toMatchObject({userId:user,channelId:ca,projectId:a});
});
it('old manual collector jobs without project identity are held before any source read',async()=>{
 const query=vi.fn();await expect(collectRssPipeline({pool:{query},userId:user,enqueuePost:vi.fn()})).rejects.toThrow('RSS project scope required');expect(query).not.toHaveBeenCalled();
});
it('holds an unassigned feed even when a later channel has a selected project',async()=>{
 const id=Number((await pool.query("insert into rss_feeds(user_id,channel_id,url,title,is_active,source_kind)values($1,$2,'https://example.test/unassigned.xml','UNASSIGNED_CANARY',true,'legal_opportunity')returning id",[user,ca])).rows[0].id);
 await pool.query("insert into rss_items(feed_id,guid,title,summary)values($1,'legacy','Изменения законодательства','UNASSIGNED_CANARY')",[id]);
 expect(JSON.stringify(await (await tab(a,()=>GET(request('/api/rss')))).json())).not.toContain('UNASSIGNED');
 const fetched:string[]=[];await collectRssPipeline({pool,userId:user,projectId:a,fetchFn:async(url:string)=>{fetched.push(url);return xml();},enqueuePost:vi.fn(),logger:{log(){},error(){}}});expect(fetched).not.toContain('https://example.test/unassigned.xml');
 await planSiteArticles(pool,{siteId:site,requestedByUserId:user});expect(JSON.stringify((await pool.query('select source_ref from site_articles where site_id=$1',[site])).rows)).not.toContain('UNASSIGNED');
 await expect(pool.query('update rss_feeds set channel_id=$2 where id=$1',[fb,ca])).rejects.toMatchObject({code:'23503'});
});
it('migrates strict legacy channel identity, supports duplicate URLs and rehearses exact old-schema restore',async()=>{
 const client=await pool.connect();const schema='rss_legacy_n18';
 try{
  await client.query(`create schema ${schema};set search_path=${schema},public`);
  await client.query(`create table users(id bigint primary key);create table projects(id bigint primary key);create table channels(id bigint primary key,project_id bigint references projects(id),unique(id,project_id));
   create table rss_feeds(id bigint primary key,user_id bigint references users(id),channel_id bigint references channels(id),url text,unique(user_id,url));
   insert into users values(1);insert into projects values(11),(22);insert into channels values(101,11),(202,null),(303,22);
   insert into rss_feeds values(1,1,101,'https://example.test/shared'),(2,1,202,'https://example.test/unassigned')`);
  const before=(await client.query('select * from rss_feeds order by id')).rows;
  const backup=execFileSync('pg_dump',['--dbname',url.href,'--schema',schema,'--no-owner','--no-acl'],{timeout:15000,maxBuffer:2*1024*1024});
  const migration=await readFile(new URL('../../db/migrations/20261019_rss_project_identity.sql',import.meta.url),'utf8');await client.query(migration);
  expect((await client.query('select id,project_id from rss_feeds order by id')).rows).toEqual([{id:'1',project_id:'11'},{id:'2',project_id:null}]);
  await client.query(migration);expect((await client.query('select project_id from rss_feeds where id=2')).rows[0].project_id).toBeNull();
  await client.query("insert into rss_feeds(id,user_id,channel_id,url,project_id)values(3,1,303,'https://example.test/shared',22) on conflict(user_id,project_id,url)do nothing");
  expect(Number((await client.query("select count(*) from rss_feeds where url='https://example.test/shared'")).rows[0].count)).toBe(2);
  // The exact prior upsert contract cannot be used by a mixed old serving pool.
  await expect(client.query("insert into rss_feeds(id,user_id,channel_id,url)values(4,1,101,'https://example.test/old') on conflict(user_id,url)do update set channel_id=excluded.channel_id")).rejects.toMatchObject({code:'42P10'});
  await expect(client.query('alter table rss_feeds add constraint rss_feeds_user_id_url_key unique(user_id,url)')).rejects.toMatchObject({code:'23505'});
  await client.query('set search_path=public');await client.query(`drop schema ${schema} cascade`);
  execFileSync('psql',['--dbname',url.href,'--set','ON_ERROR_STOP=1'],{input:backup,timeout:15000,maxBuffer:2*1024*1024,stdio:['pipe','pipe','pipe']});
  await client.query(`set search_path=${schema},public`);expect((await client.query('select * from rss_feeds order by id')).rows).toEqual(before);
  await client.query("insert into rss_feeds(id,user_id,channel_id,url)values(4,1,101,'https://example.test/old') on conflict(user_id,url)do update set channel_id=excluded.channel_id");
  expect(Number((await client.query('select count(*) from rss_feeds')).rows[0].count)).toBe(3);
 }finally{await client.query('set search_path=public');await client.query(`drop schema if exists ${schema} cascade`);client.release();}
});

it('sparse accepted legacy feed without URL preserves identity and remains unassigned after migration/reapply',async()=>{
 const schema='rss_sparse_legacy_probe';const client=await pool.connect();
 try{await client.query(`create schema ${schema};set search_path=${schema},public`);await client.query(`create table users(id bigint primary key);create table projects(id bigint primary key);create table channels(id bigint primary key,project_id bigint references projects(id),unique(id,project_id));create table rss_feeds(id bigint primary key,user_id bigint references users(id),channel_id bigint references channels(id),is_active boolean default true);insert into users values(1);insert into projects values(11);insert into channels values(101,11);insert into rss_feeds values(1,1,101,true)`);
 const migration=await readFile(new URL('../../db/migrations/20261019_rss_project_identity.sql',import.meta.url),'utf8');await client.query(migration);await client.query(migration);expect((await client.query('select id,user_id,channel_id,url,project_id from rss_feeds')).rows).toEqual([{id:'1',user_id:'1',channel_id:'101',url:null,project_id:null}]);
 }finally{await client.query('set search_path=public');await client.query(`drop schema if exists ${schema} cascade`);client.release();}
});
