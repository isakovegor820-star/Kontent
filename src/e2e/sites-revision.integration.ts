import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({pool:vi.fn(),user:vi.fn(),enqueue:vi.fn()}));
vi.mock('@/lib/db',()=>({getPool:mocks.pool}));
vi.mock('@/lib/session',()=>({getSessionUser:mocks.user}));
vi.mock('@/lib/site-articles-queue',()=>({enqueueSiteArticleJob:mocks.enqueue}));
import {POST,PATCH} from '@/app/api/sites/[id]/articles/[articleId]/route';
import {migrate} from '../../scripts/migrate.mjs';
import {approveSiteArticle,editSiteArticle,findSiteArticle,rejectSiteArticle,requestPublication} from '@/lib/sites/articles-service';
import {findSiteForProject} from '@/lib/sites/service';
import {publishSiteArticle} from '../../worker/site-articles-worker.mjs';
const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL||'http://invalid');
if(!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!='/aurora_sites_gate_test')throw new Error('Requires isolated aurora_sites_gate_test');
const pool=new pg.Pool({connectionString:url.href,max:4});let userId=0;let projectId=0;let siteId=0;
beforeAll(async()=>{
 await pool.query('drop schema public cascade');await pool.query('create schema public');await pool.query(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'));
 await migrate({env:{...process.env,DATABASE_URL:url.href},logger:{log(){}}});
 userId=Number((await pool.query("insert into users(email) values('sites-revision@example.test') returning id")).rows[0].id);
 projectId=Number((await pool.query("insert into projects(name,created_by_user_id) values('Sites revision',$1) returning id",[userId])).rows[0].id);
 await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'owner')",[projectId,userId]);
 await pool.query('insert into user_project_preferences(user_id,selected_project_id) values($1,$2)',[userId,projectId]);
 mocks.pool.mockReturnValue(pool);mocks.user.mockResolvedValue({id:userId});
 siteId=Number((await pool.query("insert into sites(project_id,user_id,confirmed_domain,canonical_url,verification_token) values($1,$2,'example.test','https://example.test','synthetic-verification-token') returning id",[projectId,userId])).rows[0].id);
});
afterAll(async()=>pool.end());
async function fixture(){
 const id=Number((await pool.query("insert into site_articles(site_id,project_id,user_id,article_type,origin,slug,status,title,body_markdown) values($1,$2,$3,'audience_answer','manual',$4,'needs_review','Reviewed title','Reviewed text') returning id",[siteId,projectId,userId,crypto.randomUUID()])).rows[0].id);
 return {site:(await findSiteForProject(pool,siteId,projectId))!,article:(await findSiteArticle(pool,siteId,id))!,userId};
}
it('never approves a version edited after the reviewer read the article',async()=>{
 const input=await fixture();await pool.query("update site_articles set title='Unseen canary',version=version+1 where id=$1",[input.article.id]);
 await expect(approveSiteArticle(pool,input)).rejects.toMatchObject({code:'article_revision_conflict'});
 const row=await findSiteArticle(pool,siteId,Number(input.article.id));expect(row?.status).toBe('needs_review');expect(row?.approved_version).toBeNull();
});
it('rejects stale edits and rejection instead of overwriting unseen content',async()=>{
 const input=await fixture();await pool.query("update site_articles set title='Unseen canary',version=version+1 where id=$1",[input.article.id]);
 await expect(editSiteArticle(pool,{...input,title:'Old-window overwrite',linkablePages:[]})).rejects.toMatchObject({code:'article_revision_conflict'});
 await expect(rejectSiteArticle(pool,input)).rejects.toMatchObject({code:'article_revision_conflict'});
 expect((await findSiteArticle(pool,siteId,Number(input.article.id)))?.title).toBe('Unseen canary');
});
it('approves only the current exact version and refuses a stale status transition',async()=>{
 const input=await fixture();const result=await approveSiteArticle(pool,input);
 expect(Number(result.row.approved_version)).toBe(Number(input.article.version));
 await expect(editSiteArticle(pool,{...input,title:'Stale status',linkablePages:[]})).rejects.toMatchObject({code:'article_revision_conflict'});
});

it('HTTP approval and edit require the revision actually shown in the UI',async()=>{
 const input=await fixture();const context={params:Promise.resolve({id:String(siteId),articleId:String(input.article.id)})};
 const request=(method:string,body:unknown)=>new NextRequest('http://localhost/api/sites/'+siteId+'/articles/'+input.article.id,{method,headers:{origin:'http://localhost','content-type':'application/json'},body:JSON.stringify(body)});
 expect((await POST(request('POST',{action:'approve'}),context)).status).toBe(400);
 await pool.query("update site_articles set title='Changed after UI read',version=version+1 where id=$1",[input.article.id]);
 const stale={version:Number(input.article.version),status:input.article.status};
 expect((await POST(request('POST',{action:'approve',...stale}),context)).status).toBe(409);
 expect((await PATCH(request('PATCH',{title:'Overwrite',...stale}),context)).status).toBe(409);
 expect(mocks.enqueue).not.toHaveBeenCalled();
 const current=(await findSiteArticle(pool,siteId,Number(input.article.id)))!;
 expect((await POST(request('POST',{action:'approve',version:Number(current.version),status:current.status}),context)).status).toBe(200);
});
it('concurrent reviewers approve only once and cannot inflate the automatic-mode streak',async()=>{
 const input=await fixture();const before=Number((await pool.query('select approved_streak from sites where id=$1',[siteId])).rows[0].approved_streak);
 const outcomes=await Promise.allSettled([approveSiteArticle(pool,input),approveSiteArticle(pool,input)]);
 expect(outcomes.filter(result=>result.status==='fulfilled')).toHaveLength(1);
 const after=Number((await pool.query('select approved_streak from sites where id=$1',[siteId])).rows[0].approved_streak);expect(after-before).toBe(1);
 const current=(await findSiteArticle(pool,siteId,Number(input.article.id)))!;
 await expect(approveSiteArticle(pool,{...input,article:current})).rejects.toMatchObject({code:'article_not_approvable'});
});

it('real worker final claim loses safely to a concurrent reviewer rejection',async()=>{
 await pool.query("update sites set verification_state='verified',hosted_slug='revision-fixture' where id=$1",[siteId]);
 await pool.query("insert into site_destinations(site_id,kind,base_url,credential_state,status) values($1,'site_hosted','https://revision.example.test','not_required','active') on conflict do nothing",[siteId]);
 const input=await fixture();const approved=await approveSiteArticle(pool,input);expect(approved.publications.length).toBe(1);
 const publish=vi.fn(async()=>({ok:true,outcome:'success',providerOperationId:'synthetic',providerRef:{slug:'synthetic'},publishedUrl:'https://revision.example.test/synthetic'}));
 let raced=false;
 const instrumented={connect:pool.connect.bind(pool),query:async(sql:string,params:unknown[])=>{
  if(sql.includes("update site_articles set status = 'publishing'")){
   raced=true;await rejectSiteArticle(pool,{...input,article:approved.row});
  }
  return pool.query(sql,params);
 }};
 const result=await publishSiteArticle(instrumented,{publicationId:Number(approved.publications[0].id)},{adapters:{site_hosted:{publish}}});
 expect(raced).toBe(true);expect(result).toMatchObject({ok:false,reason:'article_claim_lost'});expect(publish).not.toHaveBeenCalled();
 expect((await findSiteArticle(pool,siteId,Number(input.article.id)))?.status).toBe('rejected');
});
it('once the real worker wins its SQL fence, an edit cannot replace the outgoing approved payload',async()=>{
 const input=await fixture();const approved=await approveSiteArticle(pool,input);let providerCalls=0;
 const result=await publishSiteArticle(pool,{publicationId:Number(approved.publications[0].id)},{adapters:{site_hosted:{publish:async(_destination:unknown,payload:{title:string})=>{
  providerCalls++;expect(payload.title).toBe('Reviewed title');
  await expect(editSiteArticle(pool,{...input,article:approved.row,title:'Too late',linkablePages:[]})).rejects.toMatchObject({code:'article_revision_conflict'});
  return {ok:true,outcome:'success',providerOperationId:'synthetic-'+input.article.id,providerRef:{slug:input.article.slug},publishedUrl:'https://revision.example.test/'+input.article.slug};
 }}}});
 expect(result).toMatchObject({ok:true,outcome:'success'});expect(providerCalls).toBe(1);
 expect((await findSiteArticle(pool,siteId,Number(input.article.id)))?.title).toBe('Reviewed title');
});

it('concurrent update and unpublish cannot both create active intents for one article',async()=>{
 const input=await fixture();const approved=await approveSiteArticle(pool,input);
 await pool.query("update site_articles set status='published',provider_ref=$2::jsonb where id=$1",[input.article.id,JSON.stringify({slug:input.article.slug})]);
 await pool.query("update site_article_publications set status='published',outcome='success' where id=$1",[approved.publications[0].id]);
 const article=(await findSiteArticle(pool,siteId,Number(input.article.id)))!;
 const first=await pool.connect();const second=await pool.connect();
 try{
  await first.query('begin');await second.query('begin');
  const updates=await requestPublication(first,{...input,article,action:'update'});expect(updates).toHaveLength(1);
  const competing=requestPublication(second,{...input,article,action:'unpublish'}).then(value=>({value,error:null}),error=>({value:null,error}));
  await first.query('commit');const result=await competing;expect(result.error).toMatchObject({code:'article_revision_conflict'});
  await second.query('rollback');
  const pending=await pool.query("select action from site_article_publications where article_id=$1 and status='pending'",[article.id]);expect(pending.rows).toEqual([{action:'update'}]);
 }finally{await first.query('rollback');await second.query('rollback');first.release();second.release();}
});


it('approval alone cannot create publication work; a publisher explicitly owns the later operation',async()=>{
 await pool.query("update sites set verification_state='verified',hosted_slug='revision-fixture' where id=$1",[siteId]);
 await pool.query("insert into site_destinations(site_id,kind,base_url,credential_state,status) values($1,'site_hosted','https://revision.example.test','not_required','active') on conflict do nothing",[siteId]);
 const input=await fixture();
 const approver=Number((await pool.query("insert into users(email) values('sites-approver@example.test') returning id")).rows[0].id);
 const publisher=Number((await pool.query("insert into users(email) values('sites-publisher@example.test') returning id")).rows[0].id);
 await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'approver'),($1,$3,'publisher')",[projectId,approver,publisher]);
 const approved=await approveSiteArticle(pool,{...input,userId:approver});
 expect(approved.row.status).toBe('approved');expect(approved.publications).toHaveLength(0);
 expect(Number((await pool.query('select count(*) as n from site_article_publications where article_id=$1',[input.article.id])).rows[0].n)).toBe(0);
 const publications=await requestPublication(pool,{...input,article:approved.row,userId:publisher,action:'publish'});
 expect(publications).toHaveLength(1);
 expect(Number((await pool.query('select requested_by_user_id from site_article_publications where id=$1',[publications[0].id])).rows[0].requested_by_user_id)).toBe(publisher);
});
