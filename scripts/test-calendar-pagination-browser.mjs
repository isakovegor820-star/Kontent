import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "vite";
import { chromium, firefox, webkit } from "playwright-core";

// Actual CalendarPage, pagination hook, transport, dialogs and styles with local fake HTTP.
// PostgreSQL range/lifecycle behavior is exercised separately by calendar-pagination.integration.ts.
const artifactDir = resolve(process.env.E2E_ARTIFACT_DIR || "test-results/calendar-pagination");
await mkdir(artifactDir,{recursive:true});
const sources = {
  "fixture-calendar.tsx": `import React from "react";import{createRoot}from"react-dom/client";import Calendar from"@/app/app/calendar/page";import{setProjectTransport}from"@/lib/project-transport";import"@/app/globals.css";import"@/app/app/app-v3.css";setProjectTransport(7,true,1);createRoot(document.getElementById("root")).render(<Calendar/>);`,
  "fixture-store.ts": `import{useState,useEffect}from"react";const user={id:1};const channels=[{id:8,title:"Тестовый канал",network:"tg",is_active:true}];const empty=[];export function useStore(){const[revision,change]=useState([]);useEffect(()=>{const fn=()=>change([]);window.addEventListener("fixture-refresh",fn);return()=>window.removeEventListener("fixture-refresh",fn)},[]);return{user,ready:true,authReady:true,realReady:true,realError:false,realChannels:channels,realPosts:revision,posts:empty,settings:{},refreshReal:async()=>window.dispatchEvent(new Event("fixture-refresh")),toast:message=>{window.lastToast=message},retryRealPost:async()=>{},retryPost:()=>{}};}`,
  "fixture-project.ts": `const current={id:7,name:"Тестовый проект",timezone:"Europe/Amsterdam",role:"owner"};export const useProjects=()=>({current,ready:true});`,
  "fixture-navigation.ts": `export const useRouter=()=>({push:url=>{window.openedRoute=url}});export const usePathname=()=>"/app/calendar";`,
  "fixture-link.tsx": `import React from"react";export default function Link({href,children,...rest}){return <a href={href} {...rest}>{children}</a>}`,
  "fixture-shell.tsx": `import React from"react";export function AppShell({title,subtitle,action,children}){return <main className="app-v3 min-h-screen bg-bg p-4 text-text sm:p-8"><header className="mb-8 flex flex-wrap justify-between gap-3"><div><h1 className="text-2xl font-bold">{title}</h1><p>{subtitle}</p></div>{action}</header>{children}</main>}`,
};
const aliases = {"@/lib/store":"fixture-store.ts","@/components/app/project-provider":"fixture-project.ts","next/navigation":"fixture-navigation.ts","next/link":"fixture-link.tsx","@/components/app/shell":"fixture-shell.tsx"};
const bundle=await build({configFile:false,root:process.cwd(),logLevel:"error",resolve:{alias:[...Object.entries(aliases).map(([find,file])=>({find,replacement:"\0"+file})),{find:"@",replacement:resolve("src")}]},oxc:{jsx:{runtime:"automatic"}},define:{"process.env.NODE_ENV":'"production"'},plugins:[{name:"calendar-fixture",resolveId(id){if(id.endsWith("fixture-calendar.tsx"))return resolve("fixture-calendar.tsx");if(id in sources)return"\0"+id;if(id.startsWith("\0fixture-"))return id;},load(id){if(id.endsWith("fixture-calendar.tsx"))return sources["fixture-calendar.tsx"];if(id.startsWith("\0"))return sources[id.slice(1)];}}],build:{write:false,minify:false,lib:{entry:"fixture-calendar.tsx",formats:["es"]}}});
const output=(Array.isArray(bundle)?bundle[0]:bundle).output;
const javascript=output.find(item=>item.type==="chunk").code;
const css=output.filter(item=>item.type==="asset"&&item.fileName.endsWith(".css")).map(item=>item.source).join("\n");
const requests=[];const errors=[];let failing=false;let scheduled="2030-04-10T10:00:00Z";let revision=1;
const post=()=>({id:12001,author_user_id:1,author_name:"Тестовый автор",text:"Будущая публикация после всей истории",scheduled_at:scheduled,status:"scheduled",created_at:"2030-01-01T00:00:00Z",channel_id:8,channel_title:"Тестовый канал",network:"tg",publication_draft_id:41,publication_operation_id:81,publication_operation_status:"queued",operation_schedule_revision:revision,scheduled_timezone:"Europe/Amsterdam",attempts:0,publication_parts:[]});
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,"http://localhost");
 const json=(body,status=200)=>{res.writeHead(status,{"content-type":"application/json","x-aurora-project-id":"7"});res.end(JSON.stringify(body));};
 if(url.pathname==="/bundle.js"){res.writeHead(200,{"content-type":"text/javascript"});return res.end(javascript);}
 if(url.pathname==="/style.css"){res.writeHead(200,{"content-type":"text/css"});return res.end(css);}
 if(url.pathname.startsWith("/api/")){
  assert.equal(req.headers["x-aurora-project-id"],"7");requests.push({path:url.pathname,query:Object.fromEntries(url.searchParams),method:req.method});
  if(url.pathname==="/api/publication-operations/81"&&req.method==="PATCH"){
   let raw="";for await(const chunk of req)raw+=chunk;
   const input=JSON.parse(raw);scheduled=input.scheduledAt;revision++;return json({ok:true,operationId:81,scheduleRevision:revision,operationStatus:"pending"});
  }
  if(url.pathname==="/api/posts"&&url.searchParams.has("id"))return json({posts:[post()],hasMore:false,nextCursor:null});
  if(["/api/posts","/api/drafts"].includes(url.pathname)){
   const key=url.pathname.endsWith("posts")?"posts":"drafts";
   if(url.searchParams.get("view")==="range"){
    const isNext=url.searchParams.has("cursor");
    if(failing&&isNext)return json({error:"fixture_page_unavailable"},503);
    const from=Date.parse(url.searchParams.get("from")+"T00:00:00Z"),to=Date.parse(url.searchParams.get("to")+"T00:00:00Z");
    const inRange=Date.parse(scheduled)>=from&&Date.parse(scheduled)<to;
    return json({[key]:isNext&&key==="posts"&&inRange?[post()]:!isNext&&key==="posts"?[{...post(),id:12000,text:"Первая страница",scheduled_at:new Date(from+12*3600000).toISOString(),publication_draft_id:null,publication_operation_id:null}]:[],hasMore:key==="posts"&&!isNext,nextCursor:key==="posts"&&!isNext?"next":null});
   }
   return json({[key]:[],hasMore:false,nextCursor:null});
  }
  if(url.pathname==="/api/trends")return json({items:[]});
  return json({ok:true,items:[],members:[],campaigns:[]});
 }
 res.writeHead(200,{"content-type":"text/html"});res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root"></div><script type="module" src="/bundle.js"></script>');
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));const baseUrl=`http://127.0.0.1:${server.address().port}`;
try{
 for(const[engine,type]of Object.entries({chromium,firefox,webkit})){
  failing=false;scheduled="2030-04-10T10:00:00Z";revision=1;requests.length=0;
  const browser=await type.launch({headless:true});
  try{
   const context=await browser.newContext({viewport:{width:1280,height:900},timezoneId:"America/New_York",reducedMotion:"reduce"});
   await context.route("**/*",route=>new URL(route.request().url()).origin===baseUrl?route.continue():route.abort());
   const page=await context.newPage();page.on("pageerror",error=>errors.push({engine,message:error.message}));
   await page.goto(baseUrl+"/#calendar-real-12001");
   const card=page.locator("#calendar-open-real-12001");await card.waitFor();
   assert(requests.some(r=>r.query.cursor==="next"),"target reached through next page");
   await card.focus();await page.keyboard.press("Enter");assert.match(await page.evaluate(()=>window.openedRoute),/draft=41&publication=81/);
   const move=page.getByRole("button",{name:/Перетащить или выбрать другой день: Будущая/});await move.focus();await page.keyboard.press("Enter");
   await page.getByRole("dialog",{name:"Перенести публикацию"}).waitFor();await page.keyboard.press("Escape");await page.getByRole("dialog").waitFor({state:"hidden"});
   await move.click();await page.getByRole("dialog").getByRole("button",{name:/четверг/i}).click();
   await page.waitForFunction(()=>window.lastToast?.title==="Публикация перенесена");assert.equal(scheduled.slice(0,10),"2030-04-11");
   await page.getByRole("tab",{name:"Месяц",exact:true}).click();const monthDay=page.getByRole("button",{name:/11 апреля: 1 пост/});await monthDay.waitFor();
   assert(requests.some(r=>r.query.view==="range"&&r.query.from==="2030-04-01"&&r.query.to==="2030-05-06"),"month includes full adjacent-week grid");
   await page.screenshot({path:resolve(artifactDir,`${engine}-month.png`),fullPage:true});
   failing=true;await page.getByRole("button",{name:"Следующий месяц"}).click();await page.getByText(/Календарь загружен не полностью/).waitFor();
   assert.equal(await card.count(),0,"previous range is not displayed as new range");
   failing=false;await page.getByRole("button",{name:"Обновить календарь"}).click();await page.getByText(/Календарь загружен не полностью/).waitFor({state:"hidden"});
   await page.getByRole("button",{name:"Предыдущий месяц"}).click();await monthDay.waitFor();
   await page.setViewportSize({width:390,height:844});await monthDay.click();await card.waitFor();await card.click();assert.match(await page.evaluate(()=>window.openedRoute),/draft=41&publication=81/);
   await page.screenshot({path:resolve(artifactDir,`${engine}-mobile.png`),fullPage:true});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,"mobile page has no horizontal overflow");
   console.log(`${engine}: pagination, open, keyboard move, month, failed next page/recovery, mobile PASS`);
  }finally{await browser.close();}
 }
 assert.deepEqual(errors,[]);await writeFile(resolve(artifactDir,"browser-result.json"),JSON.stringify({ok:true,engines:["chromium","firefox","webkit"],errors},null,2));
}finally{await new Promise(done=>server.close(done));}
