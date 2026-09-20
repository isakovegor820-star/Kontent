import { readFile } from "node:fs/promises";
import pg from "pg";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, afterAll, it, expect, vi } from "vitest";
const mocks=vi.hoisted(()=>({pool:vi.fn(),session:vi.fn(),headers:new Headers(),enqueue:vi.fn()}));
vi.mock("server-only",()=>({}));
vi.mock("@/lib/db",()=>({getPool:mocks.pool}));
vi.mock("@/lib/session",()=>({getSessionUser:mocks.session}));
vi.mock("next/headers",()=>({headers:async()=>mocks.headers}));
vi.mock("@/lib/queue",()=>({getStatsQueue:()=>({add:mocks.enqueue})}));
import { GET as ideasGet } from "@/app/api/ideas/route";
import { PATCH as ideaPatch } from "@/app/api/ideas/[id]/route";
import { DELETE as savedDelete, POST as savedPost } from "@/app/api/library/posts/route";
import { DELETE as tagsDelete, POST as tagsPost } from "@/app/api/library/tags/route";
import { DELETE as knowledgeDelete, POST as knowledgePost } from "@/app/api/knowledge/route";
import { GET as profileGet, POST as profilePost } from "@/app/api/settings/profile/route";
import { GET as trendsGet } from "@/app/api/trends/route";
import { migrate } from "../../scripts/migrate.mjs";
const url=new URL(process.env.MIGRATION_TEST_DATABASE_URL||"postgres://invalid/invalid");
if(!["127.0.0.1","localhost"].includes(url.hostname)||url.pathname!=="/aurora_legacy_content_test"||process.env.DATABASE_URL)throw Error("Explicit disposable aurora_legacy_content_test required");
const pool=new pg.Pool({connectionString:url.href,max:4});
let user=0,a=0,b=0,channel=0,competitor=0,idea=0,saved=0,tags=0,source=0,n=0;
const canary="PRIVATE-PROJECT-A-CANARY";
function request(path:string,method="GET",body?:unknown){return new NextRequest("http://localhost/api/"+path,{method,headers:{origin:"http://localhost","content-type":"application/json",...Object.fromEntries(mocks.headers)},...(body===undefined?{}:{body:JSON.stringify(body)})});}
const context=()=>({params:Promise.resolve({id:String(idea)})});
const profileBody=()=>({requestKey:"profile:legacy:"+n,channelId:channel,name:"Owner",avatar:"",brief:{niche:canary,audience:"Team audience"}});
async function revoke(){await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2",[a,user]);}
beforeAll(async()=>{
 await pool.query("drop schema public cascade");await pool.query("create schema public");await pool.query(await readFile(new URL("../../db/schema.sql",import.meta.url),"utf8"));await migrate({env:{DATABASE_URL:url.href},logger:{log(){}}});
 user=Number((await pool.query("insert into users(email,name)values('legacy-content@example.test','Owner')returning id")).rows[0].id);
 [a,b]=(await pool.query("insert into projects(name,created_by_user_id)values('A',$1),('B',$1)returning id",[user])).rows.map(r=>Number(r.id));
 await pool.query("insert into project_members(project_id,user_id,role)values($1,$3,'owner'),($2,$3,'owner')",[a,b,user]);
 await pool.query("insert into user_project_preferences(user_id,selected_project_id)values($1,$2)",[user,a]);
 [channel]=(await pool.query("insert into channels(user_id,project_id,network,tg_chat_id)values($1,$2,'tg',-1009911),($1,$3,'tg',-1009912)returning id",[user,a,b])).rows.map(r=>Number(r.id));
 competitor=Number((await pool.query("insert into competitors(user_id,channel_id,handle,title,status)values($1,$2,'private_fixture',$3,'ready')returning id",[user,channel,canary])).rows[0].id);
 await pool.query("insert into content_brief(user_id,channel_id,niche,audience,ready)values($1,$2,$3,'Audience',true)",[user,channel,canary]);
});
beforeEach(async()=>{
 ++n;mocks.pool.mockReturnValue(pool);mocks.session.mockResolvedValue({id:user});mocks.headers=new Headers({"x-aurora-project-id":String(a)});mocks.enqueue.mockReset();
 await pool.query("update project_members set status='active',revoked_at=null,role='owner' where user_id=$1",[user]);
 idea=Number((await pool.query("insert into content_ideas(user_id,competitor_id,topic,hook,structure,why_it_worked,status,ai_status)values($1,$2,$3,'Hook','Structure','Why','new','ready')returning id",[user,competitor,canary])).rows[0].id);
 saved=Number((await pool.query("insert into saved_posts(user_id,channel_id,kind,text)values($1,$2,'own',$3)returning id",[user,channel,canary])).rows[0].id);
 tags=Number((await pool.query("insert into hashtag_sets(user_id,channel_id,name,tags)values($1,$2,$3,'{private}')returning id",[user,channel,"Tags"+n])).rows[0].id);
 source=Number((await pool.query("insert into knowledge_sources(user_id,channel_id,kind,title,raw_text)values($1,$2,'paste','Private',$3)returning id",[user,channel,canary])).rows[0].id);
});
afterAll(async()=>{await pool.end();});
it("returns ideas only from the selected project while preserving the lawful project",async()=>{
 expect(JSON.stringify(await (await ideasGet(request("ideas"))).json())).toContain(canary);
 mocks.headers.set("x-aurora-project-id",String(b));
 expect(JSON.stringify(await (await ideasGet(request("ideas"))).json())).not.toContain(canary);
});
it("rejects idea reads after membership revoke",async()=>{await revoke();expect((await ideasGet(request("ideas"))).status).toBe(403);});
it("cannot dismiss another project's idea",async()=>{mocks.headers.set("x-aurora-project-id",String(b));expect((await ideaPatch(request("ideas/"+idea,"PATCH",{action:"dismiss"}),context())).status).toBe(404);expect((await pool.query("select status from content_ideas where id=$1",[idea])).rows[0].status).toBe("new");});
it("requires current editing permission to dismiss an idea",async()=>{await pool.query("update project_members set role='publisher' where user_id=$1",[user]);expect((await ideaPatch(request("ideas/"+idea,"PATCH",{action:"dismiss"}),context())).status).toBe(403);});
it("keeps lawful idea editing",async()=>{expect((await ideaPatch(request("ideas/"+idea,"PATCH",{action:"dismiss"}),context())).status).toBe(200);expect((await pool.query("select status from content_ideas where id=$1",[idea])).rows[0].status).toBe("dismissed");});
for(const [label,handler,table,id]of [["saved post",savedDelete,"saved_posts",()=>saved],["tag set",tagsDelete,"hashtag_sets",()=>tags],["knowledge source",knowledgeDelete,"knowledge_sources",()=>source]] as const){
 it("cannot delete "+label+" from another selected project",async()=>{mocks.headers.set("x-aurora-project-id",String(b));expect((await handler(request("fixture?id="+id(),"DELETE"))).status).toBe(404);expect((await pool.query("select id from "+table+" where id=$1",[id()])).rowCount).toBe(1);});
 it("cannot delete "+label+" after membership revoke",async()=>{await revoke();expect((await handler(request("fixture?id="+id(),"DELETE"))).status).toBe(403);expect((await pool.query("select id from "+table+" where id=$1",[id()])).rowCount).toBe(1);});
 it("preserves lawful "+label+" deletion",async()=>{expect((await handler(request("fixture?id="+id(),"DELETE"))).status).toBe(200);expect((await pool.query("select id from "+table+" where id=$1",[id()])).rowCount).toBe(0);});
}
it("denies read-only publisher mutations in library and knowledge before queue work",async()=>{
 await pool.query("update project_members set role='publisher' where user_id=$1",[user]);
 for(const [handler,body]of [[savedPost,{channelId:channel,kind:"own",text:"New private text"}],[tagsPost,{channelId:channel,name:"new",tags:["news"]}],[knowledgePost,{channelId:channel,kind:"paste",title:"New",text:"New fact"}]]as const)expect((await handler(request("fixture","POST",body))).status).toBe(403);
 expect(mocks.enqueue).not.toHaveBeenCalled();
});
it("does not load another project's brief from the account profile endpoint",async()=>{
 mocks.headers.set("x-aurora-project-id",String(b));const response=await profileGet(request("settings/profile?channel="+channel));expect(response.status).toBe(404);expect(JSON.stringify(await response.json())).not.toContain(canary);
});
it("does not save another project's brief from the account profile endpoint",async()=>{mocks.headers.set("x-aurora-project-id",String(b));expect((await profilePost(request("settings/profile","POST",profileBody()))).status).toBe(404);});
it("denies saved profile operation replay after membership revoke",async()=>{
 const body=profileBody();expect((await profilePost(request("settings/profile","POST",body))).status).toBe(200);await revoke();const replay=await profilePost(request("settings/profile","POST",body));expect(replay.status).toBe(403);expect(JSON.stringify(await replay.json())).not.toContain(canary);
});
it("serializes concurrent profile updates without share-to-update deadlocks",async()=>{
 const body=profileBody();
 const results=await Promise.all([profilePost(request("settings/profile","POST",{...body,requestKey:body.requestKey+":a"})),profilePost(request("settings/profile","POST",{...body,requestKey:body.requestKey+":b"}))]);
 expect(results.map(response=>response.status)).toEqual([200,200]);
});
it("commits a lawful knowledge source before queue consumption can see it",async()=>{
 mocks.enqueue.mockImplementation(async (_name:string,data:{sourceId:number})=>{expect((await pool.query("select id from knowledge_sources where id=$1",[data.sourceId])).rowCount).toBe(1);return{id:"synthetic"};});
 expect((await knowledgePost(request("knowledge","POST",{channelId:channel,kind:"paste",title:"New",text:"Committed fact"}))).status).toBe(200);
 expect(mocks.enqueue).toHaveBeenCalledOnce();
});
it("disproves a cached internet-trend cross-project read through a foreign channel",async()=>{
 const run=Number((await pool.query("insert into radar_search_runs(user_id,channel_id,project_id,request_key,query,normalized_query,status,stage) values($1,$2,$3,$4,'private fixture','private fixture','ready','ready') returning id",[user,channel,a,"cached-trend:"+n])).rows[0].id);
 await pool.query("insert into radar_search_results(run_id,user_id,result_type,provider,canonical_key,url,handle,title,text,posted_at,reason,quality_score) values($1,$2,'post','synthetic','cached-private','https://t.me/private_fixture/1','private_fixture',$3,$3,now(),'Synthetic authorization fixture',90)",[run,user,canary]);
 const lawful=await trendsGet(request("trends?scope=internet&channel="+channel));
 expect(lawful.status).toBe(200);
 expect((await lawful.json()).items).toEqual(expect.arrayContaining([expect.objectContaining({text:canary})]));
 mocks.headers.set("x-aurora-project-id",String(b));const response=await trendsGet(request("trends?scope=internet&channel="+channel));expect(response.status).toBe(200);expect(JSON.stringify(await response.json())).not.toContain(canary);
});
