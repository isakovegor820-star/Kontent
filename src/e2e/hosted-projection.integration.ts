import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {migrate} from '../../scripts/migrate.mjs';
import {articleContentHash} from '@/lib/site-articles/service.mjs';
import type {HostedSite} from '@/lib/site-hosted/service';
const {loadHostedSite,loadHostedArticle,listHostedArticles,hostedSitemapXml} = (process.env.HOSTED_PROJECTION_SOURCE ? await import(process.env.HOSTED_PROJECTION_SOURCE) : await import('@/lib/site-hosted/service')) as typeof import('@/lib/site-hosted/service');
const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL||'postgres://invalid/invalid');
if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.pathname!='/aurora_hosted_projection_test')throw Error('Explicit disposable aurora_hosted_projection_test required');
const pool=new pg.Pool({connectionString:url.href,max:3});
const env={AURORA_SITES_DOMAIN:'sites.example.test'};
let userId=0,projectId=0,siteId=0,hostedId=0,wordpressId=0;let site:HostedSite;
const snapshot={title:'Approved original title',metaDescription:'Approved summary',bodyMarkdown:'## Approved section\n\nApproved content <script>alert(1)</script>',structuredData:{'@type':'Article',headline:'Approved original'}};
beforeAll(async()=>{
 await pool.query('drop schema public cascade');await pool.query('create schema public');await pool.query(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'));await migrate({env:{DATABASE_URL:url.href},logger:{log(){}}});
 userId=Number((await pool.query("insert into users(email) values('hosted-projection@example.invalid') returning id")).rows[0].id);
 projectId=Number((await pool.query("insert into projects(name,created_by_user_id) values('fixture',$1) returning id",[userId])).rows[0].id);
 siteId=Number((await pool.query("insert into sites(project_id,user_id,confirmed_domain,canonical_url,verification_token,verification_state,hosted_slug) values($1,$2,'fixture.example.test','https://fixture.example.test','synthetic-verification-token','verified','hosted-fixture') returning id",[projectId,userId])).rows[0].id);
 for(const kind of ['site_hosted','wordpress']){const id=Number((await pool.query("insert into site_destinations(site_id,kind,base_url,credential_state,status) values($1,$2,'https://fixture.example.test',$3,'active') returning id",[siteId,kind,kind==='site_hosted'?'not_required':'ready'])).rows[0].id);if(kind==='site_hosted')hostedId=id;else wordpressId=id;}
 site=(await loadHostedSite(pool,'hosted-fixture',env))!;expect(site).not.toBeNull();
});
afterAll(async()=>pool.end());
async function fixture({globalStatus='publishing',currentVersion=2,revision=true}:{globalStatus?:string;currentVersion?:number;revision?:boolean}={}){
 const slug='article-'+crypto.randomUUID().slice(0,8);
 const articleId=Number((await pool.query("insert into site_articles(site_id,project_id,user_id,article_type,origin,slug,status,version,title,body_markdown,body_html,approved_version,approved_by,approved_at) values($1,$2,$3,'audience_answer','manual',$4,$5,$6,'Unapproved current title','Unapproved current body','<p>Unapproved current HTML</p>',1,$3,now()) returning id",[siteId,projectId,userId,slug,globalStatus,currentVersion])).rows[0].id);
 if(revision)await pool.query("insert into site_article_revisions(article_id,version,change_kind,content_hash,snapshot) values($1,1,'approved',$2,$3)",[articleId,articleContentHash(snapshot),JSON.stringify(snapshot)]);
 await publication(articleId,hostedId,'publish','published',1,slug);
 return{articleId,slug};
}
async function publication(articleId:number,destinationId:number,action:string,status:string,version:number,slug:string){
 return Number((await pool.query("insert into site_article_publications(article_id,destination_id,article_version,idempotency_key,action,status,outcome,reconcile_state,provider_operation_id,provider_ref,published_url,completed_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()) returning id",[articleId,destinationId,version,crypto.randomUUID(),action,status,status==='published'?'success':'delivery_unknown',status==='published'?'confirmed':'unresolved',slug,JSON.stringify(destinationId===hostedId?{slug,url:`https://hosted-fixture.sites.example.test/${slug}`}:{id:99,slug}),`https://hosted-fixture.sites.example.test/${slug}`])).rows[0].id);
}
it('serves its confirmed hosted receipt and exact revision while another destination is unknown',async()=>{
 const row=await fixture();await publication(row.articleId,wordpressId,'publish','published_unverified',1,row.slug);
 const article=await loadHostedArticle(pool,site,row.slug,env);
 expect(article).toMatchObject({id:row.articleId,title:snapshot.title,metaDescription:snapshot.metaDescription,structuredData:snapshot.structuredData});
 expect(article?.bodyHtml).toContain('Approved content');expect(article?.bodyHtml).not.toContain('Unapproved');expect(article?.bodyHtml).toContain('&lt;script&gt;');expect(article?.bodyHtml).not.toContain('<script>');
 const list=await listHostedArticles(pool,site,100,env);expect(list.some(a=>a.id===row.articleId)).toBe(true);expect(hostedSitemapXml(site,list)).toContain('/'+row.slug);
});
it('never exposes mutable current content or a new slug while its update is unconfirmed',async()=>{
 const row=await fixture({globalStatus:'published'});
 await publication(row.articleId,hostedId,'update','published_unverified',2,row.slug);
 await pool.query("update site_articles set slug=$2 where id=$1",[row.articleId,row.slug+'-draft']);
 expect(await loadHostedArticle(pool,site,row.slug,env)).toMatchObject({title:snapshot.title,slug:row.slug});
 expect(await loadHostedArticle(pool,site,row.slug+'-draft',env)).toBeNull();
});
it('ignores WordPress unpublish but hides its own confirmed unpublish even if article stays published',async()=>{
 const row=await fixture({globalStatus:'published',currentVersion:1});
 await publication(row.articleId,wordpressId,'unpublish','published',1,row.slug);
 expect(await loadHostedArticle(pool,site,row.slug,env)).not.toBeNull();
 await publication(row.articleId,hostedId,'unpublish','published',1,row.slug);
 expect(await loadHostedArticle(pool,site,row.slug,env)).toBeNull();expect((await listHostedArticles(pool,site,100,env)).some(a=>a.id===row.articleId)).toBe(false);
});
it('fails closed if the exact published revision is missing or corrupt',async()=>{
 const absent=await fixture({globalStatus:'published',currentVersion:1,revision:false});expect(await loadHostedArticle(pool,site,absent.slug,env)).toBeNull();
 const corrupt=await fixture({globalStatus:'published',currentVersion:1});await pool.query("update site_article_revisions set snapshot=jsonb_set(snapshot,'{title}','\"Changed after receipt\"') where article_id=$1",[corrupt.articleId]);expect(await loadHostedArticle(pool,site,corrupt.slug,env)).toBeNull();
});
it('rechecks site and hosted destination availability even with an already-loaded site object',async()=>{
 const row=await fixture({globalStatus:'published',currentVersion:1});await pool.query("update site_destinations set status='disconnected' where id=$1",[hostedId]);
 try{expect(await loadHostedArticle(pool,site,row.slug,env)).toBeNull();expect(await listHostedArticles(pool,site,100,env)).toEqual([]);}finally{await pool.query("update site_destinations set status='active' where id=$1",[hostedId]);}
 await pool.query("update sites set verification_state='unverified' where id=$1",[siteId]);try{expect(await loadHostedArticle(pool,site,row.slug,env)).toBeNull();}finally{await pool.query("update sites set verification_state='verified' where id=$1",[siteId]);}
});
