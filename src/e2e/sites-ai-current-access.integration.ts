import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {beforeAll,beforeEach,afterAll,it,expect,vi} from 'vitest';
import {migrate} from '../../scripts/migrate.mjs';
import {generateSiteArticle} from '../../worker/site-articles-worker.mjs';
import {refineSiteProfile,interpretSiteReport} from '../../worker/site-ai-worker.mjs';
import {runSiteVisibilityProbe} from '../../worker/site-visibility-probe.mjs';
import {runDueVisibilityProbes,runSiteReportOnDemand} from '../../worker/site-scheduler.mjs';
import {buildSiteEvidenceSnapshot} from '@/lib/site-analysis/evidence.mjs';
import {extractSitePage} from '@/lib/site-crawler.mjs';
import {SITE_INTERVIEW_QUESTIONS} from '@/lib/site-analysis/questions.data.mjs';
import {processSiteAnalysisJob} from '../../worker/site-analysis-worker.mjs';
import {runSiteInterview} from '../../worker/site-analysis-interview.mjs';
import {generateText} from '@/lib/ai-provider';
import {createEmbedder} from '../../worker/embeddings.mjs';
import {withAiSpendScope} from '@/lib/ai-spend-ledger.mjs';
import {completeAiText} from '@/lib/ai-completion-service.mjs';
const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL||'http://invalid');
if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!='/aurora_sites_ai_auth_test')throw new Error('Requires disposable aurora_sites_ai_auth_test');
const pool=new pg.Pool({connectionString:url.href,max:4});let user=0,project=0,site=0,article=0,profile=0,report=0,analysis=0;
beforeAll(async()=>{await pool.query('drop schema public cascade');await pool.query('create schema public');await pool.query(await readFile(new URL('../../db/schema.sql',import.meta.url),'utf8'));await migrate({env:{...process.env,DATABASE_URL:url.href},logger:{log(){}}});
 user=Number((await pool.query("insert into users(email)values('sites-ai-access@example.test')returning id")).rows[0].id);project=Number((await pool.query("insert into projects(name,created_by_user_id)values('Site AI permission',$1)returning id",[user])).rows[0].id);await pool.query("insert into project_members(project_id,user_id,role)values($1,$2,'owner')",[project,user]);site=Number((await pool.query("insert into sites(project_id,user_id,confirmed_domain,canonical_url,verification_token)values($1,$2,'ai-access.example.test','https://ai-access.example.test','synthetic-sites-ai-verification')returning id",[project,user])).rows[0].id);
});
beforeEach(async()=>{await pool.query("update project_members set role='owner',status='active',revoked_at=null where project_id=$1 and user_id=$2",[project,user]);await pool.query('update projects set is_archived=false where id=$1',[project]);await pool.query('update users set blocked_at=null where id=$1',[user]);article=Number((await pool.query("insert into site_articles(site_id,project_id,user_id,article_type,origin,slug,status,source_ref)values($1,$2,$3,'audience_answer','manual',$4,'draft',$5::jsonb)returning id",[site,project,user,crypto.randomUUID(),JSON.stringify({kind:'manual',brief:'PRIVATE_SITE_CANARY'})])).rows[0].id); await pool.query("update sites set verification_state='verified',status='active' where id=$1",[site]);
 await pool.query("delete from ai_usage where id=99");
 await pool.query("insert into ai_usage(id,user_id,kind,status,reservation_key,reserved_at,expires_at) overriding system value values(99,$1,'sites_ai_access_fixture','reserved',$2,now(),now()+interval '10 minutes')",[user,`worker:sites-ai-fixture:${article}`]);
 const key=crypto.randomUUID();analysis=Number((await pool.query("insert into site_analysis_jobs(user_id,project_id,site_id,request_id,idempotency_key,request_fingerprint,target_url,confirmed_domain,consented_at,status,result)values($1,$2,$3,$4,$4,$4,'https://ai-access.example.test','ai-access.example.test',now(),'ready','{}')returning id",[user,project,site,key])).rows[0].id);
 await pool.query("insert into site_analysis_pages(analysis_id,url,http_status,title,main_content,technical)values($1,'https://ai-access.example.test/service',200,'PRIVATE_SITE_CANARY услуги','PRIVATE_SITE_CANARY','{\"wordCount\":400}')",[analysis]);
 profile=Number((await pool.query("insert into site_profiles(site_id,analysis_job_id,topics)values($1,$2,'[{\"key\":\"услуги\",\"label\":\"PRIVATE_SITE_CANARY услуги\"}]')returning id",[site,analysis])).rows[0].id);await pool.query('update sites set latest_profile_id=$2,latest_analysis_id=$3 where id=$1',[site,profile,analysis]);await pool.query("update site_profiles set linkable_pages='[{\"url\":\"https://ai-access.example.test/service\",\"title\":\"Услуга\"}]' where id=$1",[profile]);
 report=Number((await pool.query("insert into site_reports(site_id,profile_id,kind,payload,summary_ru,requested_by_user_id)values($1,$2,'initial_audit','{\"site\":{\"domain\":\"PRIVATE_SITE_CANARY\"}}','synthetic report',$3)returning id",[site,profile,user])).rows[0].id);
});
afterAll(async()=>pool.end());
const cases=[['revoked',"update project_members set status='revoked',revoked_at=now() where project_id=$1"],['publisher',"update project_members set role='publisher' where project_id=$1"],['archived','update projects set is_archived=true where id=$1']] as const;
for(const [name,sql] of cases)it(`queued local Sites generation denies ${name} before any model request`,async()=>{
 await pool.query(sql,[project]);const fetched=vi.fn(async()=>Response.json({message:{content:'{}'},done:true,done_reason:'stop'}));
 const complete=(request:Parameters<typeof completeAiText>[0],options:Parameters<typeof completeAiText>[1])=>completeAiText(request,{...options,allowFallback:false,env:{OLLAMA_URL:'http://127.0.0.1:11434'},fetchImpl:fetched});
 await generateSiteArticle(pool,{articleId:article},{engine:'local',embed:null,completeAiText:complete,acquireUsage:async()=>({state:'acquired',reservationId:99}),commitUsage:async()=>true,releaseUsage:async()=>true}).catch(()=>{});
 expect(fetched).not.toHaveBeenCalled();expect((await pool.query('select status from site_articles where id=$1',[article])).rows[0].status).toBe('draft');
});
it('active queued local generation reaches the actual local completion boundary',async()=>{
 const fetched=vi.fn(async()=>Response.json({message:{content:'{}'},done:true,done_reason:'stop'}));
 const complete=(request:Parameters<typeof completeAiText>[0],options:Parameters<typeof completeAiText>[1])=>completeAiText(request,{...options,allowFallback:false,env:{OLLAMA_URL:'http://127.0.0.1:11434'},fetchImpl:fetched});
 await generateSiteArticle(pool,{articleId:article},{engine:'local',embed:null,completeAiText:complete,acquireUsage:async()=>({state:'acquired',reservationId:99}),commitUsage:async()=>true,releaseUsage:async()=>true});
 expect(fetched).toHaveBeenCalledTimes(2);expect((await pool.query('select status from site_articles where id=$1',[article])).rows[0].status).toBe('failed');
});

const usage={acquireUsage:async()=>({state:'acquired',reservationId:99}),commitUsage:async()=>true,releaseUsage:async()=>true};
function deps(response='{}',onFetch?:()=>Promise<void>) {
 const fetched=vi.fn(async()=>{await onFetch?.();return Response.json({message:{content:response},done:true,done_reason:'stop'});});
 const complete=(request:Parameters<typeof completeAiText>[0],options:Parameters<typeof completeAiText>[1])=>completeAiText(request,{...options,allowFallback:false,env:{OLLAMA_URL:'http://127.0.0.1:11434'},fetchImpl:fetched});
 return {engine:'local',embed:null,completeAiText:complete,...usage,fetched};
}
const lawfulArticle=JSON.stringify({title:'Как выбрать услугу для проекта?',metaDescription:'Рассказываем, какие сведения следует подготовить для сравнения услуг и проверки условий перед началом работ.',bodyMarkdown:'Ответ зависит от задач проекта. Сравните [условия услуги](https://ai-access.example.test/service) и уточните состав работ.\n\n## Что подготовить\n\n'+Array.from({length:320},(_,i)=>`пункт${i}`).join(' ')+'\n\n## Следующий шаг\n\nОбсудите выбранные условия.',internalLinks:[],faq:[],organization:null});
it('lawful free local generation stores a complete review artifact without tariffs or spend rows',async()=>{
 const d=deps(lawfulArticle);expect(await generateSiteArticle(pool,{articleId:article},d)).toMatchObject({ok:true,status:'needs_review'});expect(d.fetched).toHaveBeenCalledTimes(1);
 expect((await pool.query('select count(*)::int n from ai_spend_attempts')).rows[0].n).toBe(0);
 expect((await pool.query('select body_markdown from site_articles where id=$1',[article])).rows[0].body_markdown).toContain('пункт319');
});
it('blocked actor is denied before generation admission',async()=>{
 await pool.query('update users set blocked_at=now() where id=$1',[user]);const d=deps();await expect(generateSiteArticle(pool,{articleId:article},d)).rejects.toMatchObject({code:'ai_work_scope_forbidden'});expect(d.fetched).not.toHaveBeenCalled();
});
for(const validResponse of [false,true])it(`revocation during admitted attempt discards output and blocks ${validResponse?'persistence':'the next attempt'}`,async()=>{
 const d=deps(validResponse?lawfulArticle:'{}',async()=>{await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1",[project]);});
 await expect(generateSiteArticle(pool,{articleId:article},d)).rejects.toMatchObject({code:'ai_work_scope_forbidden'});expect(d.fetched).toHaveBeenCalledTimes(1);
 const row=(await pool.query('select status,body_markdown,generation from site_articles where id=$1',[article])).rows[0];expect(row.status).toBe('failed');expect(row.body_markdown).toBe('');expect(row.generation).toBe(null);
});
for(const [name,sql] of cases)it(`central local attempt checks inherited ALS ${name} independently of billing config`,async()=>{
 await pool.query(sql,[project]);const fetched=vi.fn();await expect(withAiSpendScope({pool,userId:user,projectId:project},()=>completeAiText({engine:'local',user:'PRIVATE_SITE_CANARY'},{env:{OLLAMA_URL:'http://127.0.0.1:11434'},allowFallback:false,fetchImpl:fetched}))).rejects.toMatchObject({code:'ai_work_scope_forbidden'});expect(fetched).not.toHaveBeenCalled();
});
for(const path of ['classifier','interpretation','probe'] as const)for(const [name,sql] of cases)it(`${path} rejects ${name} before private context/model/persistence`,async()=>{
 await pool.query(sql,[project]);const d=deps();const work=path==='classifier'?refineSiteProfile(pool,{profileId:profile},d):path==='interpretation'?interpretSiteReport(pool,{reportId:report},d):runSiteVisibilityProbe(pool,{siteId:site,requestedByUserId:user,engines:['local']},d);
 await expect(work).rejects.toMatchObject({code:'ai_work_scope_forbidden'});expect(d.fetched).not.toHaveBeenCalled();
 expect((await pool.query('select refined_at from site_profiles where id=$1',[profile])).rows[0].refined_at).toBe(null);expect((await pool.query('select interpretation_status from site_reports where id=$1',[report])).rows[0].interpretation_status).toBe('pending');
});
for(const path of ['classifier','interpretation','probe'] as const)it(`${path} permits lawful local requests but refuses results after mid-HTTP revoke`,async()=>{
 const d=deps('{}',async()=>{await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1",[project]);});
 const work=path==='classifier'?refineSiteProfile(pool,{profileId:profile},d):path==='interpretation'?interpretSiteReport(pool,{reportId:report},d):runSiteVisibilityProbe(pool,{siteId:site,requestedByUserId:user,engines:['local']},d);
 await expect(work).rejects.toMatchObject({code:'ai_work_scope_forbidden'});expect(d.fetched).toHaveBeenCalledTimes(1);expect((await pool.query('select refined_at from site_profiles where id=$1',[profile])).rows[0].refined_at).toBe(null);
 expect((await pool.query('select count(*)::int n from site_visibility_probes where site_id=$1',[site])).rows[0].n).toBe(0);
});
it('legacy requesterless probe/report jobs require reauthorization instead of borrowing site owner',async()=>{
 const d=deps();await expect(runSiteVisibilityProbe(pool,{siteId:site,engines:['local']},d)).rejects.toMatchObject({code:'ai_work_scope_required'});
 await pool.query('update site_reports set requested_by_user_id=null,profile_id=null where id=$1',[report]);await expect(interpretSiteReport(pool,{reportId:report},d)).rejects.toMatchObject({code:'ai_work_scope_required'});
 await expect(runSiteReportOnDemand(pool,{siteId:site,requestedByUserId:null,siteArticlesQueue:null})).rejects.toMatchObject({code:'ai_work_scope_required'});expect(d.fetched).not.toHaveBeenCalled();
});
it('automatic probe supplies actual site owner and still checks current membership',async()=>{
 const d=deps('Данных для вывода недостаточно.');expect(await runDueVisibilityProbes(pool,{}, {...d,env:{SITE_PROBE_ENGINES:'local'}})).toMatchObject({due:1});expect(d.fetched.mock.calls.length).toBeGreaterThan(0);
 await pool.query('delete from site_visibility_probes where site_id=$1',[site]);await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1",[project]);const stopped=deps();const result=await runDueVisibilityProbes(pool,{}, {...stopped,env:{SITE_PROBE_ENGINES:'local'}});expect(result.results).toContainEqual(expect.objectContaining({ok:false,reason:'ai_work_scope_forbidden'}));expect(stopped.fetched).not.toHaveBeenCalled();
});

it('scoped local embedding denies revoked caller before HTTP',async()=>{
 await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1",[project]);const fetched=vi.fn(async()=>Response.json({embeddings:[Array(1024).fill(0.1)]}));
 const embed=createEmbedder({NODE_ENV:'test',OLLAMA_URL:'http://127.0.0.1:11434'},{fetchImpl:fetched});
 await expect(embed('PRIVATE_SITE_CANARY',{pool,userId:user,projectId:project})).rejects.toMatchObject({code:'ai_work_scope_forbidden'});expect(fetched).not.toHaveBeenCalled();
});

it('scoped local streaming denies revoked caller before HTTP',async()=>{
 await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1",[project]);const fetched=vi.fn(async()=>new Response(JSON.stringify({message:{content:'SECRET'},done:true})+'\n'));
 vi.stubGlobal('fetch',fetched);vi.stubEnv('OLLAMA_URL','http://127.0.0.1:11434');
 try {await expect(withAiSpendScope({pool,userId:user,projectId:project},async()=>{for await (const chunk of generateText({kind:'write',task:'PRIVATE_SITE_CANARY'},'local'))void chunk;})).rejects.toMatchObject({code:'ai_work_scope_forbidden'});expect(fetched).not.toHaveBeenCalled();}
 finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
});

it('queued deterministic site analysis denies revoked actor before crawl',async()=>{
 await pool.query("update site_analysis_jobs set status='queued',queue_confirmed_at=now() where id=$1",[analysis]);await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1",[project]);
 const crawl=vi.fn(async()=>{throw new Error('CRAWL_SHOULD_NOT_START');});await processSiteAnalysisJob(pool,{analysisId:analysis,runRevision:1},{crawl}).catch(()=>{});expect(crawl).not.toHaveBeenCalled();
});
it('analysis stops after revoke inside crawl before interview or persistence',async()=>{
 await pool.query("update site_analysis_jobs set status='queued',queue_confirmed_at=now() where id=$1",[analysis]);const crawl=vi.fn(async()=>{await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1",[project]);return {pages:[],report:{}};});const runInterview=vi.fn(async()=>{throw new Error('INTERVIEW_SHOULD_NOT_START');});
 await processSiteAnalysisJob(pool,{analysisId:analysis,runRevision:1},{crawl,runInterview,buildSnapshot:()=>({snapshotHash:'sha256:'+'a'.repeat(64),sources:[],evidence:[],entities:[],relations:[]})}).catch(()=>{});expect(crawl).toHaveBeenCalledTimes(1);expect(runInterview).not.toHaveBeenCalled();
});

function interviewSnapshot(){return buildSiteEvidenceSnapshot({confirmedDomain:'ai-access.example.test',checkedAt:'2026-09-05T12:00:00Z',pages:[extractSitePage('<html><head><title>PRIVATE_SITE_CANARY</title></head><body><main><p>Synthetic public evidence.</p></main></body></html>','https://ai-access.example.test/')]});}
const safeAnswer=(question:{id:string})=>({questionId:question.id,status:'insufficient_data',shortAnswer:'Недостаточно данных.',explanation:'В срезе нет требуемых подтверждений.',facts:[],evidenceIds:[],confidence:'none',contradictions:[],gaps:['Нужен дополнительный источник.'],requiredIntegrations:[],recommendationHooks:[]});
function interviewDeps(onFetch?:()=>Promise<void>){
 const fetched=vi.fn<typeof fetch>(async(_url,init)=>{const data=JSON.parse(String(init?.body));const body=JSON.parse(data.messages.find((message:{role:string})=>message.role==='user').content);await onFetch?.();return Response.json({message:{content:JSON.stringify({batchId:body.outputContract.batchId,reportStatus:'complete',answers:body.questions.map(safeAnswer)})},done:true,done_reason:'stop'});});
 const complete=(request:Parameters<typeof completeAiText>[0],options:Parameters<typeof completeAiText>[1])=>completeAiText(request,{...options,allowFallback:false,env:{OLLAMA_URL:'http://127.0.0.1:11434'},fetchImpl:fetched});
 return {...usage,completeAiText:complete,batchConcurrency:1,heartbeatUsage:async()=>true,fetched};
}
it('local interview completes all51 answers, persists batches, then revoked replay is denied without quota or HTTP',async()=>{
 const input={analysisId:analysis,runRevision:1,userId:user,projectId:project,requestId:'test-interview',snapshot:interviewSnapshot(),engine:'local'};const d=interviewDeps();const result=await runSiteInterview(pool,input,d);expect(result.report.answers).toHaveLength(51);expect(d.fetched.mock.calls.length).toBeGreaterThan(0);
 const before=Number((await pool.query("select count(*) n from site_analysis_ai_batches where analysis_id=$1 and status='ready'",[analysis])).rows[0].n);expect(before).toBeGreaterThan(0);
 await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1",[project]);const rejected=interviewDeps();const acquire=vi.fn(usage.acquireUsage);await expect(runSiteInterview(pool,input,{...rejected,acquireUsage:acquire})).rejects.toMatchObject({code:'ai_work_scope_forbidden'});expect(acquire).not.toHaveBeenCalled();expect(rejected.fetched).not.toHaveBeenCalled();
});
it('local interview discards an admitted provider answer when permission is revoked during HTTP',async()=>{
 const d=interviewDeps(async()=>{await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1",[project]);});
 await expect(runSiteInterview(pool,{analysisId:analysis,runRevision:1,userId:user,projectId:project,requestId:'test-interview',snapshot:interviewSnapshot(),engine:'local'},d)).rejects.toMatchObject({code:'ai_work_scope_forbidden'});
 expect(d.fetched).toHaveBeenCalledTimes(1);expect((await pool.query("select count(*)::int n from site_analysis_ai_batches where analysis_id=$1 and status='ready'",[analysis])).rows[0].n).toBe(0);
});
for(const revoke of [false,true])it(`analysis final persistence ${revoke?'rejects mid-interview revoke':'completes under current stored authority'}`,async()=>{
 await pool.query("update site_analysis_jobs set status='queued',queue_confirmed_at=now() where id=$1",[analysis]);const reservation=Number((await pool.query("insert into ai_usage(user_id,kind)values($1,'site_analysis')returning id",[user])).rows[0].id);
 const crawl=async()=>({pages:[],report:{}});const snapshot={snapshotHash:'sha256:'+'a'.repeat(64),sources:[],evidence:[],entities:[],relations:[]};
 const runInterview=async()=>{if(revoke)await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1",[project]);return {report:{reportStatus:'complete',answers:SITE_INTERVIEW_QUESTIONS.map(safeAnswer),recommendations:[]},reservationId:reservation,release:async()=>true};};
 const task=processSiteAnalysisJob(pool,{analysisId:analysis,runRevision:1},{crawl,runInterview,buildSnapshot:()=>snapshot,finalizeUsage:async()=>({status:'committed'})});
 if(revoke){await expect(task).rejects.toMatchObject({code:'ai_work_scope_forbidden'});expect((await pool.query("select count(*)::int n from site_analysis_answers where analysis_id=$1",[analysis])).rows[0].n).toBe(0);expect((await pool.query('select result from site_analysis_jobs where id=$1',[analysis])).rows[0].result).toEqual({});}
 else{expect(await task).toMatchObject({ok:true,questions:51});expect((await pool.query("select count(*)::int n from site_analysis_answers where analysis_id=$1",[analysis])).rows[0].n).toBe(51);expect((await pool.query('select status from site_analysis_jobs where id=$1',[analysis])).rows[0].status).toBe('ready');}
});

it('lawful local streaming and embeddings work with current scope and no price configuration',async()=>{
 const embed=createEmbedder({NODE_ENV:'test',OLLAMA_URL:'http://127.0.0.1:11434'},{fetchImpl:async()=>Response.json({embeddings:[Array(1024).fill(0.1)]})});expect(await embed('synthetic',{pool,userId:user,projectId:project})).toHaveLength(1024);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({message:{content:'Локальный ответ.'},done:true})+'\n')));vi.stubEnv('OLLAMA_URL','http://127.0.0.1:11434');
 try{const chunks=await withAiSpendScope({pool,userId:user,projectId:project},async()=>{const result=[];for await(const chunk of generateText({kind:'write',task:'synthetic'},'local'))result.push(chunk);return result;});expect(chunks.join('')).toContain('Локальный ответ.');}finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
});
it('current author can generate a site owner article when explicitly persisted as regeneration requester',async()=>{
 const author=Number((await pool.query("insert into users(email)values($1)returning id",[crypto.randomUUID()+'@example.test'])).rows[0].id);await pool.query("insert into project_members(project_id,user_id,role)values($1,$2,'author')",[project,author]);await pool.query('update site_articles set generation_requested_by_user_id=$2 where id=$1',[article,author]);await pool.query('update ai_usage set user_id=$1 where id=99',[author]);const d=deps(lawfulArticle);expect(await generateSiteArticle(pool,{articleId:article},d)).toMatchObject({ok:true,status:'needs_review'});expect(d.fetched).toHaveBeenCalledTimes(1);
});
it('legacy unscoped analysis and mismatched interview project cannot borrow a current site project',async()=>{
 await pool.query("update site_analysis_jobs set project_id=null,status='queued',queue_confirmed_at=now() where id=$1",[analysis]);const crawl=vi.fn();expect(await processSiteAnalysisJob(pool,{analysisId:analysis,runRevision:1},{crawl})).toMatchObject({ok:false,reason:'project_access_denied'});expect(crawl).not.toHaveBeenCalled();
 const d=interviewDeps();await expect(runSiteInterview(pool,{analysisId:analysis,runRevision:1,userId:user,projectId:project,requestId:'legacy',snapshot:interviewSnapshot(),engine:'local'},d)).rejects.toMatchObject({code:'ai_work_scope_forbidden'});expect(d.fetched).not.toHaveBeenCalled();
});
