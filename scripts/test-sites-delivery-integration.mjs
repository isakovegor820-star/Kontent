import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {migrate} from './migrate.mjs';
import {pathToFileURL} from 'node:url';
const {publishSiteArticle,reconcileSitePublication}=await import(process.env.SITE_DELIVERY_WORKER_FILE ? pathToFileURL(process.env.SITE_DELIVERY_WORKER_FILE).href : new URL('../worker/site-articles-worker.mjs',import.meta.url).href);
import {createArticlePublications} from '../src/lib/site-articles/service.mjs';
const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL||'postgres://invalid/invalid');
assert(['127.0.0.1','localhost','[::1]'].includes(url.hostname)&&url.pathname==='/aurora_sites_delivery_test');assert(!process.env.DATABASE_URL);
const pool=new pg.Pool({connectionString:url.href,max:5});
try{
 await pool.query('drop schema public cascade');await pool.query('create schema public');await pool.query(await readFile(new URL('../db/schema.sql',import.meta.url),'utf8'));await migrate({env:{DATABASE_URL:url.href},logger:{log(){}}});
 const user=(await pool.query("insert into users(email) values('sites-delivery@example.invalid') returning id")).rows[0].id;
 const project=(await pool.query("insert into projects(name,created_by_user_id) values('fixture',$1) returning id",[user])).rows[0].id;
 await pool.query("insert into project_members(project_id,user_id,role,status) values($1,$2,'owner','active')",[project,user]);
 const site=(await pool.query("insert into sites(project_id,user_id,confirmed_domain,canonical_url,verification_token,verification_state,hosted_slug) values($1,$2,'fixture.invalid','https://fixture.invalid','synthetic-verification-token','verified','fixture') returning id",[project,user])).rows[0].id;
 const destinations=[];for(const kind of ['site_hosted','wordpress'])destinations.push((await pool.query("insert into site_destinations(site_id,kind,base_url,credential_state,status) values($1,$2,'https://fixture.invalid',$3,'active') returning *",[site,kind,kind==='wordpress'?'ready':'not_required'])).rows[0]);
 let effects=0;const references={site_hosted:{slug:'hosted-fixture'},wordpress:{id:987}};
 const adapters=Object.fromEntries(Object.entries(references).map(([kind,ref])=>[kind,{
  publish:async()=>{effects++;return{ok:true,outcome:'success',providerOperationId:kind,providerRef:ref,publishedUrl:`https://${kind}.invalid/fixture`};},
  update:async(_d,input)=>{assert.deepEqual(input,ref,'update must use destination-specific receipt');effects++;return{ok:true,outcome:'success',providerOperationId:kind,providerRef:ref,publishedUrl:`https://${kind}.invalid/fixture`};},
  unpublish:async(_d,input)=>{assert.deepEqual(input,ref,'unpublish must use destination-specific receipt');effects++;return{ok:true,outcome:'success',providerOperationId:kind,providerRef:ref,publishedUrl:null};},
 }]));
 async function article(suffix){return(await pool.query("insert into site_articles(site_id,project_id,user_id,article_type,origin,slug,status,title,body_markdown,body_html,approved_by,approved_version,approved_at) values($1,$2,$3,'audience_answer','manual',$4,'approved','fixture','fixture','<p>fixture</p>',$3,1,now()) returning *",[site,project,user,suffix])).rows[0];}
 const row=await article('sequential');
 const current=async()=> (await pool.query('select * from site_articles where id=$1',[row.id])).rows[0];
 for(const action of ['publish','update','unpublish']){
  const publications=await createArticlePublications(pool,{requestedByUserId:Number(user),article:await current(),destinations,action});
  for(let index=0;index<publications.length;index++){
   const result=await publishSiteArticle(pool,{publicationId:publications[index].id},{adapters});
   assert.equal(result.ok,true,`${action} destination${index} must complete`);
   const state=await current();assert.equal(state.status,index===0?'publishing':action==='unpublish'?'retired':'published',`${action} aggregate status must include remaining destinations`);
  }
 }
 assert.equal(effects,6);
 // Current article's global ref is deliberately from the wrong provider. The
 // confirmed publication receipts, not that convenience field, stay authoritative.
 const raced=await article('concurrent');const concurrent=await createArticlePublications(pool,{requestedByUserId:Number(user),article:raced,destinations});
 const outcomes=await Promise.all(concurrent.map(p=>publishSiteArticle(pool,{publicationId:p.id},{adapters})));assert(outcomes.every(r=>r.ok));
 assert.equal((await pool.query('select status from site_articles where id=$1',[raced.id])).rows[0].status,'published');
 const partial=await article('unknown');const partialPubs=await createArticlePublications(pool,{requestedByUserId:Number(user),article:partial,destinations});
 const partialAdapters={...adapters,wordpress:{...adapters.wordpress,publish:async()=>{effects++;return{ok:false,outcome:'delivery_unknown',providerOperationId:'unknown-fixture',reason:'synthetic_receipt_lost'};},reconcile:async()=>({ok:true,outcome:'success',providerOperationId:'wordpress',providerRef:references.wordpress,publishedUrl:'https://wordpress.invalid/fixture'})}};
 assert((await publishSiteArticle(pool,{publicationId:partialPubs[0].id},{adapters:partialAdapters})).ok);
 assert.equal((await publishSiteArticle(pool,{publicationId:partialPubs[1].id},{adapters:partialAdapters})).outcome,'delivery_unknown');
 assert.equal((await pool.query('select status from site_articles where id=$1',[partial.id])).rows[0].status,'publishing');
 const before=effects;assert.equal((await publishSiteArticle(pool,{publicationId:partialPubs[1].id},{adapters:partialAdapters})).skipped,'not_pending');assert.equal(effects,before);
 assert((await reconcileSitePublication(pool,{publicationId:partialPubs[1].id},{adapters:partialAdapters})).ok);
 assert.equal((await pool.query('select status from site_articles where id=$1',[partial.id])).rows[0].status,'published');
 const precondition=await article('precondition-race');const preconditionPubs=await createArticlePublications(pool,{requestedByUserId:Number(user),article:precondition,destinations});
 let finishProvider;const finishGate=new Promise(resolve=>{finishProvider=resolve;});let providerEntered;const enteredGate=new Promise(resolve=>{providerEntered=resolve;});
 const inFlight=publishSiteArticle(pool,{publicationId:preconditionPubs[0].id},{adapters:{...adapters,site_hosted:{publish:async(...args)=>{providerEntered();await finishGate;return adapters.site_hosted.publish(...args);}}}});
 await enteredGate;await pool.query("update site_destinations set status='needs_reconnect' where id=$1",[destinations[1].id]);
 const failed=await publishSiteArticle(pool,{publicationId:preconditionPubs[1].id},{adapters});assert.equal(failed.skipped,'not_pending');
 const inFlightState=(await pool.query('select status from site_articles where id=$1',[precondition.id])).rows[0].status;
 finishProvider();await inFlight;
 assert.equal(inFlightState,'publishing','failure in one destination cannot reopen an article while another provider is in flight');
 assert.equal((await pool.query('select status from site_articles where id=$1',[precondition.id])).rows[0].status,'publishing');
 await pool.query("update site_destinations set status='active' where id=$1",[destinations[1].id]);
 const leased=await article('lost-lease');const leasedPubs=await createArticlePublications(pool,{requestedByUserId:Number(user),article:leased,destinations:[destinations[0]]});
 const leaseResult=await publishSiteArticle(pool,{publicationId:leasedPubs[0].id},{adapters:{...adapters,site_hosted:{publish:async()=>{
  await pool.query("update site_article_publications set worker_lease_token='replacement-lease' where id=$1",[leasedPubs[0].id]);
  return{ok:true,outcome:'success',providerOperationId:'fixture',providerRef:references.site_hosted,publishedUrl:'https://site_hosted.invalid/fixture'};
 }}}});
 assert.equal(leaseResult.skipped,'publication_lease_lost');
 assert.equal((await pool.query('select status from site_article_publications where id=$1',[leasedPubs[0].id])).rows[0].status,'publishing');
 console.log(JSON.stringify({ok:true,sequentialPublishUpdateUnpublish:true,destinationReferencesIsolated:true,aggregateStates:true,concurrentDestinations:true,partialUnknownNoResend:true,reconciliationFinalizesAll:true,staleCompletionFenced:true,parallelFailureKeepsApprovalFence:true,fakeEffects:effects,realProviderCalls:0}));
}finally{await pool.end();}
