import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";


// Actual CalendarPage, pagination hook, transport, dialogs and styles with local fake HTTP.
// PostgreSQL range/lifecycle behavior is exercised separately by calendar-pagination.integration.ts.
const artifactDir = resolve(process.env.E2E_ARTIFACT_DIR || "test-results/calendar-autopilot-drag");
await mkdir(artifactDir,{recursive:true});
const sources = {
  "fixture-calendar.tsx": `import React from "react";import{createRoot}from"react-dom/client";import Calendar from"@/app/app/calendar/page";import{setProjectTransport}from"@/lib/project-transport";import"@/app/globals.css";import"@/app/app/app-v3.css";setProjectTransport(7,true,1);createRoot(document.getElementById("root")).render(<Calendar/>);`,
  "fixture-store.ts": `import{useState,useEffect,useMemo}from"react";const user={id:1};const channels=[{id:8,title:"Тестовый канал",network:"tg",is_active:true}];const empty=[];const refreshReal=async()=>window.dispatchEvent(new Event("fixture-refresh"));const toast=message=>{document.getElementById("qa-status").textContent=message.title+". "+message.body};export function useStore(){const[revision,change]=useState([]);useEffect(()=>{const fn=()=>change([]);window.addEventListener("fixture-refresh",fn);return()=>window.removeEventListener("fixture-refresh",fn)},[]);return useMemo(()=>({user,ready:true,authReady:true,realReady:true,realError:false,realChannels:channels,realPosts:revision,posts:empty,settings:{},refreshReal,toast,retryRealPost:async()=>{},retryPost:()=>{}}),[revision]);}`,
  "fixture-project.ts": `const current={id:7,name:"Тестовый проект",timezone:"Europe/Amsterdam",role:"owner"};export const useProjects=()=>({current,ready:true});`,
  "fixture-navigation.ts": `export const useRouter=()=>({push:url=>{document.getElementById("qa-status").textContent="Открыт редактор: "+url}});export const usePathname=()=>"/app/calendar";`,
  "fixture-link.tsx": `import React from"react";export default function Link({href,children,...rest}){return <a href={href} {...rest}>{children}</a>}`,
  "fixture-shell.tsx": `import React from"react";export function AppShell({title,subtitle,action,children}){return <main className="app-v3 min-h-screen bg-bg p-4 text-text sm:p-8"><header className="mb-8 flex flex-wrap justify-between gap-3"><div><h1 className="text-2xl font-bold">{title}</h1><p>{subtitle}</p></div>{action}</header>{children}</main>}`,
};
const aliases = {"@/lib/store":"fixture-store.ts","@/components/app/project-provider":"fixture-project.ts","next/navigation":"fixture-navigation.ts","next/link":"fixture-link.tsx","@/components/app/shell":"fixture-shell.tsx"};
const bundle=await build({configFile:false,root:process.cwd(),logLevel:"error",resolve:{alias:[...Object.entries(aliases).map(([find,file])=>({find,replacement:"\0"+file})),{find:"@",replacement:resolve("src")}]},oxc:{jsx:{runtime:"automatic"}},define:{"process.env.NODE_ENV":'"production"'},plugins:[{name:"calendar-fixture",resolveId(id){if(id.endsWith("fixture-calendar.tsx"))return resolve("fixture-calendar.tsx");if(id in sources)return"\0"+id;if(id.startsWith("\0fixture-"))return id;},load(id){if(id.endsWith("fixture-calendar.tsx"))return sources["fixture-calendar.tsx"];if(id.startsWith("\0"))return sources[id.slice(1)];}}],build:{write:false,minify:false,lib:{entry:"fixture-calendar.tsx",formats:["es"]}}});
const output=(Array.isArray(bundle)?bundle[0]:bundle).output;
const javascript=output.find(item=>item.type==="chunk").code;
const css=output.filter(item=>item.type==="asset"&&item.fileName.endsWith(".css")).map(item=>item.source).join("\n");

let scheduled="2030-04-10T10:00:00.000Z", revision=1;
const requests=[];
const post=()=>({id:12001,author_user_id:1,author_name:"Тестовый автор",text:"Тест переноса: пост автопилота",scheduled_at:scheduled,status:"scheduled",publication_origin:"autopilot",autopilot_can_reschedule:true,schedule_revision:revision,created_at:"2030-01-01T00:00:00Z",channel_id:8,channel_title:"Тестовый канал",network:"tg",publication_draft_id:null,publication_operation_id:null,publication_operation_status:null,operation_schedule_revision:null,scheduled_timezone:"Europe/Amsterdam",attempts:0,publication_parts:[]});
async function evidence(){await writeFile(resolve(artifactDir,"browser-state.json"),JSON.stringify({post:post(),requests},null,2));}
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,"http://localhost");
 const json=(body,status=200)=>{res.writeHead(status,{"content-type":"application/json","x-aurora-project-id":"7"});res.end(JSON.stringify(body));};
 if(url.pathname==="/bundle.js"){res.writeHead(200,{"content-type":"text/javascript"});return res.end(javascript);}
 if(url.pathname==="/style.css"){res.writeHead(200,{"content-type":"text/css"});return res.end(css);}
 if(url.pathname.startsWith("/api/")){
  assert.equal(req.headers["x-aurora-project-id"],"7");
  if(url.pathname==="/api/autopilot/item/schedule"&&req.method==="PATCH"){
   let raw="";for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);
   requests.push({method:"PATCH",input});
   if(input.scheduleRevision!==revision)return json({ok:false,error:"post_changed"},409);
   scheduled=input.scheduledAt;revision++;await evidence();
   return json({ok:true,...input,scheduleRevision:revision,queuePending:false});
  }
  if(url.pathname==="/api/posts"){
   const from=Date.parse(url.searchParams.get("from")+"T00:00:00Z"),to=Date.parse(url.searchParams.get("to")+"T00:00:00Z");
   return json({posts:url.searchParams.has("id")||(Date.parse(scheduled)>=from&&Date.parse(scheduled)<to)?[post()]:[],hasMore:false,nextCursor:null});
  }
  if(url.pathname==="/api/drafts")return json({drafts:[],hasMore:false,nextCursor:null});
  return json({ok:true,items:[],members:[],campaigns:[]});
 }
 res.writeHead(200,{"content-type":"text/html"});res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><aside id="qa-status" role="status" style="position:fixed;bottom:0;background:white;border:2px solid blue;padding:12px;z-index:100">Изолированная проверка календаря</aside><script type="module" src="/bundle.js"></script>');
});
await new Promise(done=>server.listen(Number(process.env.CALENDAR_PREVIEW_PORT ?? 3317),"127.0.0.1",done));await evidence();
console.log(`Calendar fixture: http://127.0.0.1:${server.address().port}/#calendar-real-12001`);
