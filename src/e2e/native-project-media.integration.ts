import { readFile } from "node:fs/promises";
import pg from "pg";
import { NextRequest } from "next/server";
import { beforeAll,beforeEach,afterAll,describe,it,expect,vi } from "vitest";
const mocks=vi.hoisted(()=>({getPool:vi.fn(),getSessionUser:vi.fn(),objectStream:vi.fn(),librarySnapshot:vi.fn()}));
vi.mock("@/lib/db",()=>({getPool:mocks.getPool}));
vi.mock("@/lib/session",()=>({getSessionUser:mocks.getSessionUser}));
vi.mock("@/lib/media-storage.mjs", async (original) => ({ ...await original<typeof import("@/lib/media-storage.mjs")>(), mediaObjectRangeStream: mocks.objectStream }));
vi.mock("@/lib/library-registry", () => ({ buildLibraryRegistrySnapshot: mocks.librarySnapshot }));
import { POST as exportPost } from "@/app/api/library/exports/route";
import { GET as reportGet } from "@/app/api/sites/[id]/reports/[reportId]/export/route";
import { GET as analysisGet } from "@/app/api/site-analysis/[id]/export/route";
import { GET as assetGet } from "@/app/api/media/assets/[id]/route";
import { GET as exportGet } from "@/app/api/library/exports/[id]/route";
import { migrate } from "../../scripts/migrate.mjs";
const url=process.env.MIGRATION_TEST_DATABASE_URL||"";const target=new URL(url);
if(!["127.0.0.1","localhost"].includes(target.hostname)||target.pathname!=="/aurora_native_media_test")throw new Error("Requires disposable local aurora_native_media_test");
const pool=new pg.Pool({connectionString:url,ssl:false,max:8});
let user=0,projectA=0,projectB=0,asset=0,snapshot=0,site=0,report=0,analysis=0,channel=0;
const bytes=Buffer.from([137,80,78,71]);
const request=(query=`projectId=${projectA}`,headers={})=>assetGet(new NextRequest(`http://localhost/api/media/assets/${asset}?${query}`,{headers}),{params:Promise.resolve({id:String(asset)})});
beforeAll(async()=>{
 await pool.query("drop schema public cascade");await pool.query("create schema public");await pool.query(await readFile(new URL("../../db/schema.sql",import.meta.url),"utf8"));await migrate({env:{...process.env,DATABASE_URL:url},logger:{log(){}}});
 user=Number((await pool.query("insert into users(email,name)values('native-media@example.test','Native') returning id")).rows[0].id);
 [projectA,projectB]=(await pool.query("insert into projects(name,created_by_user_id) values('A',$1),('B',$1) returning id",[user])).rows.map(r=>Number(r.id));
 await pool.query("insert into project_members(project_id,user_id,role)values($1,$3,'owner'),($2,$3,'owner')",[projectA,projectB,user]);
 await pool.query("insert into user_project_preferences(user_id,selected_project_id)values($1,$2)",[user,projectA]);
 await pool.query("insert into media_storage_policy(id,user_max_bytes,project_max_bytes,global_max_bytes)values(1,10000000,10000000,10000000)");
 asset=Number((await pool.query("insert into media_assets(user_id,project_id,kind,file_name,mime_type,bytes,sha256,data,origin) values($1,$2,'image','native.png','image/png',4,$3,$4,'upload')returning id",[user,projectA,'a'.repeat(64),bytes])).rows[0].id);
 channel=Number((await pool.query("insert into channels(user_id,project_id,network,tg_chat_id,title)values($1,$2,'tg',-100986655,'Native')returning id",[user,projectA])).rows[0].id);
 snapshot=Number((await pool.query("insert into library_export_snapshots(user_id,channel_id,request_key,formula_version,snapshot)values($1,$2,'native-export-key','library-v1',$3::jsonb)returning id",[user,channel,JSON.stringify({exportedAt:'2026-09-05T00:00:00Z',activeFilters:{},formulaVersion:'library-v1',items:[]})])).rows[0].id);
 site=Number((await pool.query("insert into sites(project_id,user_id,confirmed_domain,canonical_url,verification_token)values($1,$2,'native.test','https://native.test/','native-test-token-1234')returning id",[projectA,user])).rows[0].id);
 report=Number((await pool.query("insert into site_reports(site_id,kind,payload,summary_ru)values($1,'on_demand','{\"canary\":\"project-A\"}','Native report')returning id",[site])).rows[0].id);
 analysis=Number((await pool.query("insert into site_analysis_jobs(user_id,project_id,request_id,idempotency_key,request_fingerprint,target_url,confirmed_domain,consented_at,status,result) values($1,$2,'native-report-1','native-report-1','native-report-1','https://native.test/','native.test',now(),'ready',$3::jsonb)returning id",[user,projectA,JSON.stringify({osint:{reportStatus:'complete',answers:[],summary:{answered:0,total:0}}})])).rows[0].id);
});
beforeEach(async()=>{mocks.getPool.mockReturnValue(pool);mocks.getSessionUser.mockResolvedValue({id:user});await pool.query("update project_members set status='active',revoked_at=null where user_id=$1",[user]);await pool.query("update user_project_preferences set selected_project_id=$2 where user_id=$1",[user,projectA]);});
afterAll(async()=>{await pool.end();});
describe("D02 native project-bound media and exports",()=>{
 it("keeps tab A native image readable after tab B changes the shared preference",async()=>{
  await pool.query("update user_project_preferences set selected_project_id=$2 where user_id=$1",[user,projectB]);
  const response=await request();expect(response.status).toBe(200);expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
 });
 it("refuses a requested project that differs from the asset instead of silently using the preference",async()=>{expect((await request(`projectId=${projectB}`)).status).toBe(404);});
 it("requires an explicit native request selector and rejects malformed/conflicting selectors",async()=>{
  expect((await request("")).status).toBe(403);
  expect((await request("projectId=wat")).status).toBe(403);
  expect((await request(`projectId=${projectA}&projectId=${projectB}`)).status).toBe(403);
  expect((await request(`projectId=${projectA}`,{"x-aurora-project-id":String(projectB)})).status).toBe(403);
 });
 it("denies a revoked member before both bytes and conditional cache responses",async()=>{
  const first=await request();await first.arrayBuffer();
  await pool.query("update project_members set status='revoked',revoked_at=now()where user_id=$1 and project_id=$2",[user,projectA]);
  expect((await request()).status).toBe(403);expect((await request(`projectId=${projectA}`,{"if-none-match":first.headers.get('etag')||''})).status).toBe(403);
 });
 it("does not make project media reusable through a long-lived browser cache",async()=>{const response=await request();expect(response.headers.get('cache-control')).toContain('no-store');await response.arrayBuffer();});
 it("denies an already-created library snapshot after the channel project membership is revoked",async()=>{
  await pool.query("update project_members set status='revoked',revoked_at=now()where user_id=$1 and project_id=$2",[user,projectA]);
  const response=await exportGet(new NextRequest(`http://localhost/api/library/exports/${snapshot}?format=csv&projectId=${projectA}`),{params:Promise.resolve({id:String(snapshot)})});
  expect(response.status).toBe(403);
 });
 it("serves only the requested byte range with current project authorization",async()=>{
  const response=await request(`projectId=${projectA}`,{range:"bytes=1-2"});
  expect(response.status).toBe(206);expect(response.headers.get("content-range")).toBe("bytes 1-2/4");expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes.subarray(1,3));
  expect((await request(`projectId=${projectA}`,{range:"bytes=4-5"})).status).toBe(416);
 });
 it("stops PostgreSQL media before the next chunk after a committed revoke",async()=>{
  const large=Buffer.alloc(2*1024*1024,7);
  const id=Number((await pool.query("insert into media_assets(user_id,project_id,kind,file_name,mime_type,bytes,sha256,data,origin)values($1,$2,'image','large.png','image/png',$3,$4,$5,'upload')returning id",[user,projectA,large.length,'b'.repeat(64),large])).rows[0].id);
  const response=await assetGet(new NextRequest(`http://localhost/api/media/assets/${id}?projectId=${projectA}`),{params:Promise.resolve({id:String(id)})});
  const reader=response.body!.getReader();expect((await reader.read()).value?.byteLength).toBe(1024*1024);
  await pool.query("update project_members set status='revoked',revoked_at=now()where user_id=$1 and project_id=$2",[user,projectA]);
  await expect(reader.read()).rejects.toThrow("membership_required");
 });
 it("proxies object bytes without issuing a reusable capability URL and stops after revoke",async()=>{
  const id=Number((await pool.query("insert into media_assets(user_id,project_id,kind,file_name,mime_type,bytes,sha256,storage_backend,object_key,origin)values($1,$2,'video','private.mp4','video/mp4',8,$3,'object','projects/private/test.mp4','upload')returning id",[user,projectA,'c'.repeat(64)])).rows[0].id);
  const cancel=vi.fn();mocks.objectStream.mockResolvedValue(new ReadableStream({pull(c){c.enqueue(new Uint8Array([1,2,3,4]));},cancel},{highWaterMark:0}));
  const response=await assetGet(new NextRequest(`http://localhost/api/media/assets/${id}?projectId=${projectA}`),{params:Promise.resolve({id:String(id)})});
  expect(response.status).toBe(200);expect(response.headers.get("location")).toBeNull();expect(response.headers.get("cache-control")).toContain("no-store");
  const reader=response.body!.getReader();expect((await reader.read()).value).toEqual(new Uint8Array([1,2,3,4]));
  await pool.query("update project_members set status='revoked',revoked_at=now()where user_id=$1 and project_id=$2",[user,projectA]);
  await expect(reader.read()).rejects.toThrow("membership_required");expect(cancel).toHaveBeenCalledOnce();
 });
 it("binds library snapshot downloads to the explicit project and refuses other projects",async()=>{
  await pool.query("update user_project_preferences set selected_project_id=$2 where user_id=$1",[user,projectB]);
  const download=(project:number)=>exportGet(new NextRequest(`http://localhost/api/library/exports/${snapshot}?format=csv&projectId=${project}`),{params:Promise.resolve({id:String(snapshot)})});
  expect((await download(projectA)).status).toBe(200);expect((await download(projectB)).status).toBe(404);
 });
 it("binds Sites reports and analysis exports to the explicit project across a second tab switch and revoke",async()=>{
  await pool.query("update user_project_preferences set selected_project_id=$2 where user_id=$1",[user,projectB]);
  const downloads=(project:number)=>[
   ()=>reportGet(new NextRequest(`http://localhost/api/sites/${site}/reports/${report}/export?format=json&projectId=${project}`),{params:Promise.resolve({id:String(site),reportId:String(report)})}),
   ()=>analysisGet(new NextRequest(`http://localhost/api/site-analysis/${analysis}/export?format=json&projectId=${project}`),{params:Promise.resolve({id:String(analysis)})}),
  ];
  for(const download of downloads(projectA)){const response=await download();expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toContain("no-store");await response.arrayBuffer();}
  for(const download of downloads(projectB))expect((await download()).status).toBe(404);
  await pool.query("update project_members set status='revoked',revoked_at=now()where user_id=$1 and project_id=$2",[user,projectA]);
  for(const download of downloads(projectA))expect((await download()).status).toBe(403);
 });

 it("keeps idempotent snapshot metadata and links in the selected project",async()=>{
  const response=await exportPost(new NextRequest("http://localhost/api/library/exports",{method:"POST",headers:{"content-type":"application/json","idempotency-key":"native-export-key"},body:JSON.stringify({filters:{channel}})}));
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({replay:true,id:snapshot,formats:expect.arrayContaining([{format:"csv",href:`/api/library/exports/${snapshot}?format=csv&projectId=${projectA}`}])});
 });
 it("does not replay foreign project snapshot metadata or insert a snapshot for a different project",async()=>{
  await pool.query("update user_project_preferences set selected_project_id=$2 where user_id=$1",[user,projectB]);
  mocks.librarySnapshot.mockResolvedValue({channelId:channel,formulaVersion:"library-v1",items:[]});
  for(const key of ["native-export-key","native-new-key-project-b"]){
   const response=await exportPost(new NextRequest("http://localhost/api/library/exports",{method:"POST",headers:{"content-type":"application/json","idempotency-key":key},body:JSON.stringify({filters:{channel}})}));
   expect(response.status).toBe(410);expect(await response.json()).toEqual({ok:false,error:"snapshot_expired"});
  }
  expect(Number((await pool.query("select count(*) from library_export_snapshots")).rows[0].count)).toBe(1);
 });

});
