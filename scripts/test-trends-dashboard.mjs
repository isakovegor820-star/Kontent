import { fileURLToPath } from "node:url";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import net from "node:net";
import pg from "pg";
import { chromium } from "playwright-core";
import { seedTrendQa } from "./trends-qa-fixtures.mjs";

// Disposable, local-only harness. It never writes .env.local, never connects a worker
// to the working database, and drops only the random database created by this process.
const configFile = process.env.TRENDS_QA_ENV_FILE || new URL("../.env.local", import.meta.url);
const existing = parseEnv(await readFile(configFile, "utf8").catch(error => {
  if (error.code === "ENOENT") return "";
  throw error;
}));
const connection = process.env.TRENDS_QA_ADMIN_URL || process.env.DATABASE_URL || existing.DATABASE_URL;
if (!connection) throw new Error("Set TRENDS_QA_ADMIN_URL to a local PostgreSQL connection");
const adminUrl = new URL(connection);
if (!["127.0.0.1", "localhost"].includes(adminUrl.hostname)) throw new Error("Local PostgreSQL required");
adminUrl.pathname = "/postgres";
const database = `aurora_trends_qa_${randomUUID().replaceAll("-", "")}`;
const databaseUrl = new URL(adminUrl); databaseUrl.pathname = `/${database}`;
const admin = new pg.Pool({ connectionString: adminUrl.href, ssl: false, max: 1 });
const pool = new pg.Pool({ connectionString: databaseUrl.href, ssl: false, max: 3 });
const reportDir = new URL("../reports/trends-dashboard-2026-09-09/", import.meta.url);
await mkdir(reportDir, { recursive: true });
const processes = [];
let created = false, browser, page, app;
async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.on("error", reject);
    server.listen(0,"127.0.0.1",()=> { const assigned=server.address().port;server.close(()=>resolve(assigned)); });
  });
}
function launch(command, args, env, label) {
  const child=spawn(command,args,{cwd:process.cwd(),env,detached:true,stdio:["ignore","pipe","pipe"]});
  processes.push(child);
  let output=""; child.stdout.on("data",chunk=>{output+=chunk;});child.stderr.on("data",chunk=>{output+=chunk;});
  child.output=()=>output;
  child.once("exit",(code)=>{if(code) console.log(`[trends:qa] ${label} exited ${code}`);});
  return child;
}
async function command(args,env) {
  const child=launch(process.execPath,args,env,"check");
  const code=await new Promise(resolve=>child.once("exit",resolve));
  console.log(child.output());
  if(code!==0) throw new Error(`QA command failed (${code})`);
}
try {
  await admin.query(`create database ${database}`); created=true;
  await pool.query(await readFile(new URL("../db/schema.sql",import.meta.url),"utf8"));
  await pool.query("update trend_sources set enabled=false");
  const webPort=await port(),redisPort=await port();
  const baseUrl=`http://127.0.0.1:${webPort}`;
  const env={...process.env,DATABASE_URL:databaseUrl.href,REDIS_URL:`redis://127.0.0.1:${redisPort}`,
    APP_URL:baseUrl,NEXT_PUBLIC_APP_URL:baseUrl,TOKENS_MASTER_KEY:randomBytes(32).toString("hex"),TOKENS_KEY_ID:"1",
    TG_BOT_TOKEN:"",VK_TOKEN:"",SENTRY_AUTH_TOKEN:"",AURORA_SENTRY_DISABLED:"1",NEXT_PUBLIC_AURORA_SENTRY_DISABLED:"1",
    NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES:"1"};
  await command(["node_modules/vitest/vitest.mjs","run","--config","vitest.integration.config.ts","src/e2e/trend-statistics.integration.ts"],env);
  if(process.argv.includes("--sql-only")) {
    console.log("[trends:qa] SQL integration passed; disposing temporary database.");
  } else {
    launch("/opt/homebrew/bin/redis-server",["--bind","127.0.0.1","--port",String(redisPort),"--save","","--appendonly","no"],env,"temporary Redis");
    const fixture=await seedTrendQa(pool);
    const rawSession=randomBytes(32).toString("hex");
    await pool.query("insert into sessions (token_hash,user_id,expires_at,device,credential_epoch) select $1,id,now()+interval '1 hour','trends-dashboard-qa',credential_epoch from users where id=$2",[createHash("sha256").update(rawSession).digest("hex"),fixture.user]);
    app=launch("npm",["run","dev","--","--webpack","-H","127.0.0.1","-p",String(webPort)],env,"application and full worker");
    const deadline=Date.now()+90_000;
    while(Date.now()<deadline) {
      try{const response=await fetch(`${baseUrl}/api/health`);if(response.ok)break;}catch{}
      if(app.exitCode!=null) throw new Error(app.output().slice(-9000));
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    browser=await chromium.launch({headless:true,executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
    const context=await browser.newContext({baseURL:baseUrl,viewport:{width:1440,height:1000}});
    await context.addCookies([{name:"sid",value:rawSession,url:baseUrl,httpOnly:true,sameSite:"Lax"}]);
    page=await context.newPage();
    const issues=[];page.on("pageerror",error=>issues.push(error.message));
    await page.goto(`/app/trends?scope=internet&q=${encodeURIComponent('ремонт квартиры')}&period=month&view=statistics&run=${fixture.paginatedRun}&channel=${fixture.channel}`,{waitUntil:"domcontentloaded",timeout:90000});
    await page.getByRole("heading",{name:"Тема: ремонт квартиры",exact:true}).waitFor({timeout:60000});
    await page.getByRole("heading",{name:"Публикации по времени",exact:true}).waitFor();
    await page.screenshot({path:fileURLToPath(new URL("desktop.png",reportDir)),fullPage:true});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)) throw new Error("Desktop horizontal overflow");
    await page.getByRole("tab",{name:"Публикации",exact:true}).first().click();
    await page.getByText(/Показаны 1–24 из 30/).waitFor();
    await page.getByRole("button",{name:"Далее",exact:true}).click();
    await page.getByText(/Показаны 25–30 из 30/).waitFor();
    await page.getByRole("tab",{name:"Статистика",exact:true}).click();
    await page.getByRole("heading",{name:"Публикации по времени",exact:true}).waitFor();
    if(await page.locator('#internet-feed-search').inputValue()!=='ремонт квартиры') throw new Error("Query lost while switching views");
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:fileURLToPath(new URL("mobile.png",reportDir)),fullPage:true});
    if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)) throw new Error("Mobile horizontal overflow: " + JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("body *")].filter(el=>el.getBoundingClientRect().right>window.innerWidth+1).slice(0,14).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right})))) );
    // The full ninety-day window must also fit the same narrow screen.
    await page.getByRole("tab",{name:"Мои конкуренты",exact:true}).click();
    await page.getByRole("tab",{name:"90 дней",exact:true}).click();
    await page.locator('#internet-feed-search').fill('');
    await page.getByRole("button",{name:"Показать",exact:true}).click();
    await page.getByRole("heading",{name:"Публикации по времени",exact:true}).waitFor();
    if(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)) throw new Error("Quarter chart horizontal overflow");
    await page.screenshot({path:fileURLToPath(new URL("mobile-quarter.png",reportDir)),fullPage:true});
    await page.getByRole("tab",{name:"30 дней",exact:true}).click();
    await page.locator('#internet-feed-search').fill('ремонт квартиры');
    await page.getByRole("button",{name:"Показать",exact:true}).click();
    // Successful publication membership and partial search states are verified separately from live providers.
    await pool.query("update radar_search_runs set status='partial',error_message='QA: частичный результат' where id=$1",[fixture.paginatedRun]);
    await page.getByRole("tab",{name:"Поиск по теме",exact:true}).click();
    await page.getByRole("status").filter({hasText:"Собрано частично"}).waitFor();
    await page.screenshot({path:fileURLToPath(new URL("partial-search.png",reportDir)),fullPage:true});
    if(process.argv.includes("--live-search")) {
      await page.setViewportSize({width:1440,height:1000});
      await page.locator('#internet-feed-search').fill('искусственный интеллект');
      await page.getByRole('button',{name:'Найти',exact:true}).click();
      const liveDeadline=Date.now()+180000;
      let live;
      while(Date.now()<liveDeadline) {
        await new Promise(resolve=>setTimeout(resolve,2000));
        const response=await page.request.get(`/api/trends/stats?source=internet&period=month&topic=${encodeURIComponent('искусственный интеллект')}&channel=${fixture.channel}`,{headers:{'x-aurora-project-id':String(fixture.project)}});
        if(response.ok()) {
          live=await response.json();
          if(live.search && ['ready','partial','failed'].includes(live.search.status))break;
        }
      }
      const { items, topItems, ...totals } = live || {};
      const evidence = item => ({ link:item.link, handle:item.handle, views:item.views, reactions:item.reactions,
        postedAt:item.postedAt, measuredAt:item.measuredAt, median:item.median, baselinePosts:item.baselinePosts, ratio:item.ratio });
      await writeFile(new URL("live-search.json",reportDir),JSON.stringify({ ...totals,
        items:items?.map(evidence), topItems:topItems?.map(evidence) },null,2));
      console.log(`[trends:qa] live search ${live?.search?.status}: ${live?.summary?.posts??0} publications`);
      await page.screenshot({path:fileURLToPath(new URL("live-search.png",reportDir)),fullPage:true});
      if(!live?.search || ['queued','running'].includes(live.search.status)) throw new Error("Live search did not reach a terminal state");
    }
    await writeFile(new URL("browser-check.json",reportDir),JSON.stringify({controlledFixtures:true,desktop:true,mobile:true,mobileQuarter:true,pagination:true,queryPreserved:true,partialState:true,pageErrors:issues},null,2));
    await writeFile(new URL("runtime.log",reportDir),app.output());
    if(issues.length) throw new Error(`Browser errors: ${issues.join('; ')}`);
    console.log("[trends:qa] Desktop/mobile rendering, pagination, query preservation and partial state passed.");
  }
} catch (error) {
  if (app) await writeFile(new URL("runtime.log", reportDir), app.output());
  if (page) {
    await page.screenshot({path:fileURLToPath(new URL("failure.png",reportDir)),fullPage:true,timeout:10000}).catch(()=>{});
    console.log("[trends:qa] page:", page.url(), (await page.locator("body").innerText().catch(()=>"")).slice(0,7000));
  }
  throw error;
} finally {
  await browser?.close();
  for(const child of processes.reverse()) {
    if(child.exitCode==null) { try{process.kill(-child.pid,"SIGTERM");}catch{} }
  }
  await new Promise(resolve=>setTimeout(resolve,1000));
  for(const child of processes) {
    if(child.exitCode==null) { try{process.kill(-child.pid,"SIGKILL");}catch{} }
  }
  await pool.end();
  if(created) { await admin.query(`drop database ${database} with (force)`); console.log("[trends:qa] Temporary database removed; no project configuration files changed."); }
  await admin.end();
}
