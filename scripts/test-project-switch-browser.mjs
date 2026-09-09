import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { build } from "vite";
import { chromium, firefox, webkit } from "playwright-core";

// Component browser gate; production API serialization is covered separately by
// project-dto-contract.test.ts. No account, provider, database or external network.
const artifactDir = resolve(process.env.E2E_ARTIFACT_DIR || "test-results/project-switch");
await mkdir(artifactDir, { recursive: true });
const temporary = await mkdtemp(join(tmpdir(), "aurora-project-browser-"));
const project = (id) => ({ id, name: `Проект ${id}`, timezone: "UTC", role: "owner", version: 1, personal: false, selected: true, createdAt: "" });
let selected = 1;
let loseResponse = false;
let offline = false;
const mutations = [];
const errors = [];
let delayedRead = null;
const bundle = await build({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { alias: [
    { find: "@/lib/store", replacement: "\0fixture-store.ts" },
    { find: "@", replacement: resolve("src") },
  ] },
  oxc: { jsx: { runtime: "automatic" } },
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{ name: "project-browser-fixture",
    resolveId(id) { if (id.endsWith("fixture-project.tsx")) return resolve("fixture-project.tsx"); if (id === "\0fixture-store.ts") return id; },
    load(id) {
      if (id === "\0fixture-store.ts") return "export const useStore=()=>({user:{id:7},authReady:true,toast:()=>{}});";
      if (id.endsWith("fixture-project.tsx")) return `
    import React, {useState} from "react";
    import {useProjectFetch} from "@/lib/use-project-transport";
    import { createRoot } from "react-dom/client";
    import { ProjectProvider,useProjects } from "@/components/app/project-provider";
    import { ProjectSwitcher } from "@/components/app/project-switcher";
    function Content() { const {current}=useProjects(); const fetch=useProjectFetch(); const [result,setResult]=useState(""); const [saved,setSaved]=useState(0); const [saveError,setSaveError]=useState(""); return <main>
      <ProjectSwitcher/><h1>{current?.name ?? "Загрузка"}</h1>
      <button id="save" onClick={()=>{void fetch("/api/projects/current",{method:"PATCH"}).then(async response=>{if(!response.ok)throw new Error("save HTTP "+response.status);await response.json();setSaved(value=>value+1);}).catch(error=>setSaveError(String(error)));}}>Сохранить контент</button>
      <button id="read" onClick={()=>fetch("/api/channels").then(r=>r.json()).then(body=>setResult(body.label)).catch(()=>{})}>Загрузить каналы</button>
      <output id="read-result">{result}</output>
      <output id="save-count">{saved}</output><output id="save-error">{saveError}</output>
    </main>; }
    createRoot(document.getElementById("root")).render(<ProjectProvider><Content/></ProjectProvider>);
  `;
    },
  }],
  build: { write: false, minify: false, lib: { entry: "fixture-project.tsx", formats: ["es"] } },
});
const output = (Array.isArray(bundle) ? bundle[0] : bundle).output;
const javascript = output.find((item) => item.type === "chunk").code;
const server = http.createServer(async (req, res) => {
  const json = (body) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url === "/bundle.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(javascript); }
  if (req.url === "/api/projects/current" && req.method === "PUT") {
    let body = ""; for await (const chunk of req) body += chunk;
    selected = Number(JSON.parse(body).projectId);
    if (loseResponse) { req.socket.destroy(); return; }
    return json({ ok: true, project: project(selected) });
  }
  if (req.url === "/api/projects/current" && req.method === "PATCH") {
    const projectId = Number(req.headers["x-aurora-project-id"]);
    if (![1,2].includes(projectId)) { res.writeHead(428); return res.end("missing selector"); }
    mutations.push(projectId); res.setHeader("x-aurora-project-id", String(projectId));
    return json({ ok: true, projectId });
  }
  if (req.url === "/api/channels") {
    const projectId = Number(req.headers["x-aurora-project-id"]);
    delayedRead = () => { if (!res.destroyed) { res.setHeader("x-aurora-project-id", String(projectId)); json({ label: "Данные проекта " + projectId }); } };
    return;
  }
  if (req.url?.startsWith("/api/")) {
    if (offline) { res.writeHead(503); return res.end("offline fixture"); }
    if (req.url === "/api/projects/current") return json({ ok: true, project: project(selected) });
    if (req.url === "/api/projects") return json({ ok: true, projects: [project(1),project(2)].map((item) => ({ ...item, selected: item.id === selected })) });
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><meta charset="utf-8"><style>
    :root{--bg:#fff;--text:#20242b}body{font:18px system-ui;margin:40px;background:#f3f4f7}main{padding:24px;background:white}
    button,select{font:inherit;min-height:44px;margin:12px}h1{font-size:30px}.contents{display:contents}
    .fixed{position:fixed;inset:0;z-index:100;background:#0006;display:flex;align-items:center;justify-content:center}
    .fixed>div{background:white;padding:24px;max-width:440px;border-radius:16px}
  </style><div id="root"></div><script type="module" src="/bundle.js"></script>`);
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
try {
  for (const [engine, browserType] of Object.entries({ chromium, firefox, webkit })) {
    selected = 1; loseResponse = false; offline = false; mutations.length = 0;
    const browser = await browserType.launch({ headless: true });
    try {
      const context = await browser.newContext();
      await context.route("**/*", (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push({ engine, message: error.message }));
      await page.goto(baseUrl);
      await page.getByRole("heading", { name: "Проект 1" }).waitFor();
      const other = await context.newPage();
      other.on("pageerror", (error) => errors.push({ engine, message: error.message }));
      await other.goto(baseUrl);
      await other.getByRole("heading", { name: "Проект 1" }).waitFor();
      await other.getByLabel("Текущий проект").selectOption("2");
      await other.getByRole("heading", { name: "Проект 2" }).waitFor();
      await page.locator("#save").click();
      await other.locator("#save").click();
      await page.waitForFunction(() => document.querySelector("#save-count")?.textContent === "1");
      await other.waitForFunction(() => document.querySelector("#save-count")?.textContent === "1");
      assert.equal(await page.locator("#save-error").textContent(), "");
      assert.equal(await other.locator("#save-error").textContent(), "");
      assert.deepEqual(mutations, [1, 2], "two tabs retain independent action selectors");
      mutations.length = 0;
      // A response begun in A must never repaint the screen after this tab switches to B.
      await page.locator("#read").click();
      await page.waitForTimeout(25);
      await page.getByLabel("Текущий проект").selectOption("2");
      await page.getByRole("heading", { name: "Проект 2" }).waitFor();
      assert.equal(typeof delayedRead, "function"); delayedRead(); delayedRead = null;
      await page.waitForTimeout(25);
      assert.equal(await page.locator("#read-result").textContent(), "");
      await other.close();
      await page.locator("#save").click();
      await page.waitForFunction(() => document.querySelector("#save-count")?.textContent === "1");
      assert.equal(await page.locator("#save-error").textContent(), "");
      await page.waitForFunction(() => !document.querySelector("[inert]"));
      assert.deepEqual(mutations, [2]);
      // The server commits A while the PUT response is lost; GET repairs the UI.
      loseResponse = true;
      await page.getByLabel("Текущий проект").selectOption("1");
      await page.getByRole("heading", { name: "Проект 1" }).waitFor();
      await page.waitForFunction(() => !document.querySelector("[inert]"));
      // Keep the old screen blocked if the subsequent authoritative read is down.
      offline = true;
      await page.getByLabel("Текущий проект").selectOption("2");
      await page.getByRole("button", { name: "Обновить проект" }).waitFor();
      assert.equal(await page.locator("#save").evaluate((element) => Boolean(element.closest("[inert]"))), true);
      const before = mutations.length;
      const saveBounds = await page.locator("#save").boundingBox();
      await page.mouse.click(saveBounds.x + 5, saveBounds.y + 5);
      assert.equal(mutations.length, before);
      await page.screenshot({ path: join(artifactDir, `${engine}-unresolved.png`) });
      offline = false;
      await page.getByRole("button", { name: "Обновить проект" }).click();
      await page.getByRole("heading", { name: "Проект 2" }).waitFor();
      await page.waitForFunction(() => !document.querySelector("[inert]"));
      await page.screenshot({ path: join(artifactDir, `${engine}-recovered.png`) });
      assert.equal(await page.locator("#save-error").textContent(), "");
      await context.close();
      console.log(`${engine}: two-tab selectors, stale read, switch, lost response, inert barrier and recovery passed`);
    } finally { await browser.close(); }
  }
  assert.deepEqual(errors, []);
  await writeFile(join(artifactDir, "browser-result.json"), JSON.stringify({ passed: true, engines: ["chromium","firefox","webkit"], errors }, null, 2));
} finally {
  await new Promise((done) => server.close(done));
  await rm(temporary, { recursive: true, force: true });
}
