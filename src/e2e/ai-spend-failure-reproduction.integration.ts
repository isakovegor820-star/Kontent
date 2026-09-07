import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeAiText } from "@/lib/ai-completion-service.mjs";
import { reserveAiUsage, releaseAiUsage } from "@/lib/ai-usage";
import { migrate } from "../../scripts/migrate.mjs";
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const target = new URL(databaseUrl);
if (!["127.0.0.1","localhost"].includes(target.hostname) || target.pathname !== "/aurora_d03_test") throw new Error("D03 requires disposable local aurora_d03_test");
const pool = new pg.Pool({ connectionString:databaseUrl,ssl:false,max:8 });
let userId=0; let projectId=0; let paid=0; let port=0;
let providerMode: "broken" | "stream" = "broken";
const provider=createServer(async(req,res)=> { for await(const _ of req) void _; paid+=1; res.writeHead(200,{"content-type":"application/json"}); if(providerMode === "stream") res.end('data: {"choices":[{"delta":{"content":"PARTIAL"}}]}\n\n'); else res.end('{"choices":[{"message":{"content":"paid partial'); });
beforeAll(async()=> {
  await pool.query("drop schema public cascade"); await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql",import.meta.url),"utf8"));
  await migrate({env:{...process.env,DATABASE_URL:databaseUrl},logger:{log(){}}});
  userId=Number((await pool.query("insert into users (email,name) values ('d03@example.test','D03') returning id")).rows[0].id);
  projectId=Number((await pool.query("insert into projects (name,created_by_user_id) values ('D03',$1) returning id",[userId])).rows[0].id);
  await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'owner')",[projectId,userId]);
  await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
  const addr=provider.address(); if(!addr || typeof addr==='string') throw new Error('provider bind'); port=addr.port;
});
afterAll(async()=> {await pool.end();await new Promise<void>(resolve=>provider.close(()=>resolve()));});
describe("D03 paid-failure monetary guarantee",()=> {
  it("stops paid partial failures with new request keys despite refunding the user generation quota",async()=> {
    const env={ NAVYAI_API_KEY:"disposable",NAVYAI_API_URL:`http://127.0.0.1:${port}/v1`,
      AI_SPEND_USER_DAILY_MICROUSD:"9000",AI_SPEND_PROJECT_DAILY_MICROUSD:"20000",AI_SPEND_GLOBAL_DAILY_MICROUSD:"30000",
      AI_SPEND_USER_CONCURRENCY:"4",AI_SPEND_PROJECT_CONCURRENCY:"8",AI_SPEND_GLOBAL_CONCURRENCY:"12",
      AI_SPEND_TARIFFS_JSON:JSON.stringify({"navy-deepseek-pro/deepseek-v4-pro":{inputMicrousdPerMillionTokens:1000000,outputMicrousdPerMillionTokens:1000000}}),
    };
    let capRejected=false;
    for(let i=0;i<4;i++) {
      const usage=await reserveAiUsage(userId,"d03-failure",{limit:1,reservationKey:`d03:${randomUUID()}`},pool);
      expect(usage.allowed).toBe(true);
      try { await completeAiText({system:"S",user:"U",engine:"navy-deepseek-pro",maxTokens:700},
        {env,allowFallback:false,maxAttempts:1,circuitFailureThreshold:20,spendScope:{pool,userId,projectId}}); }
      catch(error) { if((error as {code?:string}).code==="ai_spend_cap_exceeded") capRejected=true; }
      await releaseAiUsage(userId,usage.reservationId,pool);
    }
    expect(paid).toBeLessThanOrEqual(2);
    expect(capRejected).toBe(true);
    expect((await pool.query("select count(*)::int n from ai_usage where user_id=$1 and status='released'",[userId])).rows[0].n).toBe(4);
  });
});

// All tests below exercise the same PostgreSQL authority as web and worker processes.
// Each test receives an empty ledger, while the security reproduction above keeps user quota separate.
import { beforeEach } from "vitest";
import { beginAiSpendAttempt, withAiSpendScope, withSystemAiSpendScope, type AiSpendScope } from "@/lib/ai-spend-ledger.mjs";
import { generateText } from "@/lib/ai-provider";
import { createEmbedder, EMBED_DIM } from "../../worker/embeddings.mjs";
import { createNavyMediaClient } from "@/lib/navy-media.mjs";
const model = { provider:"navy-deepseek-pro",model:"deepseek-v4-pro",inputTokens:50,outputTokens:50 };
const accountingEnv = (overrides:Record<string,string>={}) => ({
  AI_SPEND_USER_DAILY_MICROUSD:"1000",AI_SPEND_PROJECT_DAILY_MICROUSD:"2000",AI_SPEND_GLOBAL_DAILY_MICROUSD:"3000",
  AI_SPEND_USER_CONCURRENCY:"10",AI_SPEND_PROJECT_CONCURRENCY:"20",AI_SPEND_GLOBAL_CONCURRENCY:"30",
  AI_SPEND_TARIFFS_JSON:JSON.stringify({"navy-deepseek-pro/deepseek-v4-pro":{inputMicrousdPerMillionTokens:1000000,outputMicrousdPerMillionTokens:1000000}}),
  ...overrides,
});
const attempt = (env=accountingEnv(),scope:AiSpendScope={pool,userId,projectId}) => beginAiSpendAttempt(model,{env,scope});
async function anotherScope(sameProject=false):Promise<AiSpendScope> {
  const uid=Number((await pool.query("insert into users(email,name) values($1,'Scope') returning id",[`${randomUUID()}@example.test`])).rows[0].id);
  const pid=sameProject?projectId:Number((await pool.query("insert into projects(name,created_by_user_id) values('Scope',$1) returning id",[uid])).rows[0].id);
  await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'owner')",[pid,uid]);
  return {pool,userId:uid,projectId:pid};
}
describe("D03 atomic accounting, restart and paid boundaries",()=> {
  beforeEach(async()=> { await pool.query("delete from ai_spend_attempts"); });
  it("fails closed before a paid request when scope, exact tariff or budget is absent",async()=> {
    await expect(beginAiSpendAttempt(model,{env:accountingEnv()})).rejects.toMatchObject({code:"ai_spend_scope_required"});
    await expect(attempt(accountingEnv({AI_SPEND_USER_DAILY_MICROUSD:"0"}))).rejects.toMatchObject({code:"ai_spend_configuration_required"});
    await expect(attempt(accountingEnv({AI_SPEND_TARIFFS_JSON:"{}"}))).rejects.toMatchObject({code:"ai_spend_configuration_required",dimension:"tariff"});
    expect((await pool.query("select count(*)::int n from ai_spend_attempts")).rows[0].n).toBe(0);
  });
  it("atomically enforces the user cap across concurrent requests",async()=> {
    const env=accountingEnv({AI_SPEND_USER_DAILY_MICROUSD:"200"});
    const results=await Promise.allSettled(Array.from({length:8},()=>attempt(env)));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(2);
    for(const result of results) if(result.status==='rejected') expect(result.reason).toMatchObject({code:"ai_spend_cap_exceeded",dimension:"user"});
    expect((await pool.query("select sum(reserved_microusd)::text n from ai_spend_attempts")).rows[0].n).toBe("200");
  });
  it("enforces project cap across different users",async()=> {
    const second=await anotherScope(true); const env=accountingEnv({AI_SPEND_PROJECT_DAILY_MICROUSD:"100"});
    await attempt(env);
    await expect(attempt(env,second)).rejects.toMatchObject({code:"ai_spend_cap_exceeded",dimension:"project"});
  });
  it("enforces global cap across different projects",async()=> {
    const second=await anotherScope();const env=accountingEnv({AI_SPEND_GLOBAL_DAILY_MICROUSD:"100"});
    await attempt(env);
    await expect(attempt(env,second)).rejects.toMatchObject({code:"ai_spend_cap_exceeded",dimension:"global"});
  });
  it.each(["user","project","global"] as const)("enforces %s concurrency and releases only finalized active slots",async(dimension)=> {
    const second=dimension==='user'?{pool,userId,projectId}:await anotherScope(dimension==='project');
    const env=accountingEnv({[`AI_SPEND_${dimension.toUpperCase()}_CONCURRENCY`]:"1"});
    const first=await attempt(env);
    await expect(attempt(env,second)).rejects.toMatchObject({code:"ai_spend_concurrency_exceeded",dimension});
    await first.finish({outcome:"unknown"});
    await expect(attempt(env,second)).resolves.toHaveProperty('id');
  });
  it("retains a lost-response reservation after restart and lease expiry",async()=> {
    const env=accountingEnv({AI_SPEND_USER_DAILY_MICROUSD:"100",AI_SPEND_USER_CONCURRENCY:"1"});
    const first=await attempt(env); // Simulated process death: no finish call.
    await pool.query("update ai_spend_attempts set lease_expires_at=now()-interval '1 second' where id=$1",[first.id]);
    const restartedPool=new pg.Pool({connectionString:databaseUrl,ssl:false});
    try {
      await expect(attempt(env,{pool:restartedPool,userId,projectId})).rejects.toMatchObject({code:"ai_spend_cap_exceeded"});
      expect((await restartedPool.query("select status,charged_microusd,reserved_microusd::text from ai_spend_attempts where id=$1",[first.id])).rows[0])
        .toMatchObject({status:"reserved",charged_microusd:null,reserved_microusd:"100"});
    } finally { await restartedPool.end(); }
  });
  it("accounts provider-reported usage on failed output and finalizes once",async()=> {
    const first=await attempt();
    await first.finish({outcome:"failed",usage:{inputTokens:4,outputTokens:6}});
    await first.finish({outcome:"succeeded",usage:{inputTokens:0,outputTokens:0}});
    expect((await pool.query("select status,usage_known,charged_microusd::text from ai_spend_attempts where id=$1",[first.id])).rows[0])
      .toMatchObject({status:"failed",usage_known:true,charged_microusd:"10"});
  });
  it("blocks revoked membership and archived projects before reservation",async()=> {
    const scope=await anotherScope();
    await pool.query("update project_members set status='revoked',revoked_at=now() where user_id=$1",[scope.userId]);
    await expect(attempt(accountingEnv(),scope)).rejects.toMatchObject({code:"ai_spend_scope_forbidden"});
    await pool.query("update project_members set status='active',revoked_at=null where user_id=$1",[scope.userId]);
    await pool.query("update projects set is_archived=true where id=$1",[scope.projectId]);
    await expect(attempt(accountingEnv(),scope)).rejects.toMatchObject({code:"ai_spend_scope_forbidden"});
  });
  it("denies a queued author after role demotion while preserving the publisher reply permission",async()=> {
    const scope=await anotherScope();
    await pool.query("update project_members set role='publisher' where project_id=$1 and user_id=$2",[scope.projectId,scope.userId]);
    await expect(attempt(accountingEnv(),scope)).rejects.toMatchObject({code:"ai_spend_scope_forbidden"});
    await expect(attempt(accountingEnv(),{...scope,permission:"audience.reply.send"})).resolves.toHaveProperty("id");
  });
  it("includes an explicitly assigned system account in the global cap",async()=> {
    const scope=await anotherScope();const env=accountingEnv({AI_SPEND_GLOBAL_DAILY_MICROUSD:"100",AI_SPEND_SYSTEM_USER_ID:String(scope.userId),AI_SPEND_SYSTEM_PROJECT_ID:String(scope.projectId)});
    await withSystemAiSpendScope(pool,()=>beginAiSpendAttempt(model,{env}),env);
    await expect(attempt(env)).rejects.toMatchObject({code:"ai_spend_cap_exceeded",dimension:"global"});
  });
  it("charges a truncated streamed response without terminal usage",async()=> {
    const previous={...process.env};
    Object.assign(process.env,accountingEnv({AI_SPEND_USER_DAILY_MICROUSD:"100000",AI_SPEND_PROJECT_DAILY_MICROUSD:"100000",AI_SPEND_GLOBAL_DAILY_MICROUSD:"100000"}),{NAVYAI_API_KEY:"fake",NAVYAI_API_URL:`http://127.0.0.1:${port}/v1`});
    try {
      await withAiSpendScope({pool,userId,projectId},async()=> {
        try { for await(const _ of generateText({kind:"write",task:"S"},"navy-deepseek-pro")) void _; } catch { /* fake provider returns broken payload */ }
      });
      const rows=(await pool.query("select status,usage_known,charged_microusd=reserved_microusd as retained from ai_spend_attempts")).rows;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(row=>row.status==='unknown' && !row.usage_known && row.retained)).toBe(true);
    } finally { for(const key of Object.keys(process.env)) if(!(key in previous)) delete process.env[key];Object.assign(process.env,previous); }
  });
  it("retains cost when the consumer cancels after its first streamed delta",async()=> {
    const previous={...process.env};
    Object.assign(process.env,accountingEnv({AI_SPEND_USER_DAILY_MICROUSD:"100000",AI_SPEND_PROJECT_DAILY_MICROUSD:"100000",AI_SPEND_GLOBAL_DAILY_MICROUSD:"100000"}),{NAVYAI_API_KEY:"fake",NAVYAI_API_URL:`http://127.0.0.1:${port}/v1`});
    providerMode="stream";
    try {
      await withAiSpendScope({pool,userId,projectId},async()=> {
        const stream=generateText({kind:"write",task:"S"},"navy-deepseek-pro");
        expect((await stream.next()).value).toBe("PARTIAL");
        await stream.return(undefined);
      });
      const rows=(await pool.query("select status,usage_known,charged_microusd=reserved_microusd as retained from ai_spend_attempts")).rows;
      expect(rows).toEqual([{status:"unknown",usage_known:false,retained:true}]);
    } finally { providerMode="broken";for(const key of Object.keys(process.env)) if(!(key in previous)) delete process.env[key];Object.assign(process.env,previous); }
  });
  it("meters cloud embeddings including rejected or malformed responses",async()=> {
    let calls=0;
    const env={...accountingEnv(),NODE_ENV:"test" as const,AI_API_KEY:"fake",AI_API_URL:`http://127.0.0.1:${port}/v1`,
      AI_SPEND_TARIFFS_JSON:JSON.stringify({"openai-embedding/text-embedding-3-small":{inputMicrousdPerMillionTokens:1000000,outputMicrousdPerMillionTokens:0}})};
    const embed=createEmbedder(env,{fetchImpl:async()=>{calls++;return Response.json({data:[{embedding:Array(EMBED_DIM).fill(0)}],usage:{prompt_tokens:5}});}});
    expect(await embed("hello",{pool,userId,projectId})).toHaveLength(EMBED_DIM);
    expect((await pool.query("select provider,charged_microusd::text,usage_known from ai_spend_attempts")).rows[0]).toMatchObject({provider:"openai-embedding",charged_microusd:"5",usage_known:true});
    await expect(embed("missing scope")).rejects.toMatchObject({code:"ai_spend_scope_required"});expect(calls).toBe(1);
  });
  it("meters accepted media creates while free status polling does not create another charge",async()=> {
    const previous={...process.env};let creates=0;
    Object.assign(process.env,accountingEnv({AI_SPEND_TARIFFS_JSON:JSON.stringify({"navy-media/nano-banana-2":{inputMicrousdPerMillionTokens:0,outputMicrousdPerMillionTokens:0,unitMicrousd:500}})}));
    const client=createNavyMediaClient({apiKey:"fake",baseUrl:`http://127.0.0.1:${port}/v1`,fetchImpl:async(_url,options)=>{if(options?.method==='POST') creates++;return Response.json(options?.method==='POST'?{id:"test-media-job"}:{status:"pending"});}});
    try {
      await withAiSpendScope({pool,userId,projectId},()=>client.create({payload:{model:"nano-banana-2",prompt:"fake"},requestKey:"fake",requestId:"fake",signal:undefined}));
      await client.poll({providerJobId:"test-media-job",requestId:"fake",signal:undefined});
      expect(creates).toBe(1);
      expect((await pool.query("select count(*)::int n,sum(charged_microusd)::text total from ai_spend_attempts")).rows[0]).toEqual({n:1,total:"500"});
    } finally {for(const key of Object.keys(process.env)) if(!(key in previous)) delete process.env[key];Object.assign(process.env,previous);}
  });
});
