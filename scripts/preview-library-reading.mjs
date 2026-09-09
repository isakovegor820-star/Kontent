// Local component QA only. Uses the actual page/components and synthetic API responses;
// no accounts, database, providers, worker queues or production mutations are involved.
import http from "node:http";
import { resolve } from "node:path";
import { build } from "vite";

const virtual = {
  "fixture-navigation": `export const useRouter=()=>({push:url=>window.alert("Тестовый переход: "+url),replace:()=>{}}); export const useSearchParams=()=>new URLSearchParams("channel=1");`,
  "fixture-link": `import React from "react"; export default function Link({children,...props}) { return <a {...props}>{children}</a>; }`,
  "fixture-store": `const state={realReady:true,realChannels:[{id:1,title:"Редакция Авроры",handle:"aurora",network:"tg",is_active:true}],toast:()=>{}};export const useStore=()=>state;`,
  "fixture-shell": `export function AppShell({title,subtitle,children}) { return <main className="app-v3" data-theme="light" style={{padding:"24px clamp(16px,3vw,40px) 48px",minHeight:"100vh"}}><header style={{maxWidth:1180,margin:"0 auto 24px"}}><h1>{title}</h1><p style={{fontSize:14,color:"var(--text-3)",marginTop:8}}>{subtitle}</p></header>{children}</main>; }`,
  "fixture-entry": `import React from "react";import {createRoot} from "react-dom/client";import Page from "@/app/app/library/page";import "@/app/globals.css";import "@/app/app/app-v3.css"; createRoot(document.getElementById("root")).render(<Page/>);`,
};
const bundled = await build({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { alias: [
    { find: "next/navigation", replacement: "fixture-navigation" },
    { find: "next/link", replacement: "fixture-link" },
    { find: "@/lib/store", replacement: "fixture-store" },
    { find: "@/components/app/shell", replacement: "fixture-shell" },
    { find: "@", replacement: resolve("src") },
  ] },
  oxc: { jsx: { runtime: "automatic" } },
  define: { "process.env.NODE_ENV": '"production"', "process.env": "{}" },
  plugins: [{ name: "library-reading-fixture",
    resolveId(id) { if (id.endsWith("fixture-entry.tsx")) return "\0fixture-entry.tsx"; if (virtual[id]) return `\0${id}.tsx`; },
    load(id) { return virtual[id.replace(/^\0/u, "").replace(/\.tsx$/u, "")] ?? null; },
  }],
  build: { write: false, minify: false, lib: { entry: resolve("fixture-entry.tsx"), formats: ["es"] } },
});
const output = (Array.isArray(bundled) ? bundled[0] : bundled).output;
const javascript = output.find((part) => part.type === "chunk").code;
const css = output.filter((part) => part.type === "asset" && part.fileName.endsWith(".css")).map((part) => part.source).join("\n");
const texts = [
  ["Как объяснить сложную новость простым языком", "Читателю важно быстро понять, что произошло и как это связано с его жизнью. Редакция разбирает подход: один главный факт, короткое объяснение и конкретный пример.", "Начните с изменения, которое затрагивает аудиторию. Добавьте контекст, без которого факт легко понять неправильно. Завершите практическим выводом.\n\nЭто пример материала для проверки интерфейса, а не реальная новость."],
  ["Почему одни заголовки помогают читать, а другие отвлекают", "Небольшой разбор редакционных приёмов: понятный предмет, конкретное действие и обещание, которое выполняет текст. Без лишней интриги и сложных формулировок.", "Хороший заголовок помогает заранее оценить пользу публикации. В этом примере можно проверить открытие полного текста и возвращение к ленте."],
  ["Один вопрос аудитории — три идеи для публикации", "Ответить коротко, показать на примере или разобрать распространённую ошибку. Аврора предлагает превратить вопрос подписчика в небольшую серию полезных материалов.", "Сначала выберите один вопрос. Подготовьте объяснение, затем иллюстрацию и чек-лист. Показатели ниже относятся к исходной публикации."],
  ["Что изменилось в привычках читателей: наблюдения редакции", "Короткие абзацы и ясная структура помогают ориентироваться в материале. Разбираемся, как сохранить глубину текста и при этом сделать его удобным для чтения с телефона.", "Длинный текст не обязательно трудный. Помогают хороший ритм, понятные переходы и достаточное пространство между абзацами."],
  ["Новый материал: данные ещё накапливаются", "Публикация недавно появилась в источнике. Здесь можно прочитать текст и сохранить его, даже если просмотры и реакции пока неизвестны.", "Отсутствие данных не означает нулевой результат. Интерфейс показывает прочерк до поступления статистики."],
  ["Чек-лист перед публикацией: четыре быстрые проверки", "Заголовок соответствует тексту, ссылка ведёт к источнику, главный вывод понятен, а следующий шаг помогает читателю. Небольшой материал, который удобно сохранить.", "Этот текст используется только для проверки карточек, фильтров и окна чтения."],
];
let rows = texts.map(([title, intro, rest], index) => ({
  id: `${index === 2 ? "idea" : "reference"}:${index + 1}`, kind: index === 2 ? "idea" : "reference", channelId: 1, channelTitle: "Редакция Авроры",
  sourceId: String(index % 2 + 1), sourceTitle: index % 2 ? "Медиа и тексты" : "Редакционная практика", sourceUrl: "https://example.com", sourceData: "public_telegram",
  text: `${title}\n\n${intro}\n\n${rest}`, postedAt: new Date(Date.now() - (index + 1) * 3600_000).toISOString(), format: "text",
  saved: false, viewedAt: index === 3 ? new Date().toISOString() : null, userRating: null,
  views: index === 4 ? null : 5620 - index * 611, reactions: index === 4 ? null : 124 - index * 12, lift: index === 4 ? null : 1.8 - index * .13,
  erBayes: .02, velocity: 42, velocityZ: .8, freshness: .9, analyticsScore: 91.3 - index * 4, formulaVersion: "v1", dataQuality: "high", dataMaturity: "mature", isHit: false,
  ...(index === 2 ? { idea: { topic: title } } : {}),
}));
let offline = false;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:4319");
  function send(body, type = "application/json", status = 200) { res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" }); res.end(type === "application/json" ? JSON.stringify(body) : body); }
  if (url.pathname === "/bundle.js") return send(javascript, "text/javascript");
  if (url.pathname === "/bundle.css") return send(css, "text/css");
  if (url.pathname === "/fixture/new") { rows = [{ ...rows[0], id: `reference:${Date.now()}`, text: "Новая публикация появилась в источнике\n\nЛента сохраняет место чтения до нажатия на плашку.", postedAt: new Date().toISOString() }, ...rows]; return send({ ok: true }); }
  if (url.pathname === "/fixture/offline") { offline = !offline; return send({ offline }); }
  if (url.pathname === "/api/library/registry") {
    if (offline) return send({ ok: false }, "application/json", 503);
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    const source = url.searchParams.get("source");
    const filtered = rows.filter((row) => (!q || `${row.text} ${row.sourceTitle}`.toLowerCase().includes(q)) && (!source || source === row.sourceId));
    return send({ ok: true, items: filtered, diagnostics: { competitorCount: 2, sourcePostCount: rows.length, readyIdeaCount: 1, pendingIdeaCount: 0, totalItemCount: rows.length, lastCollectedAt: new Date(Date.now() - 120_000).toISOString(), failedSourceCount: 0 } });
  }
  if (req.method === "POST" && ["/api/library/state", "/api/library/posts"].includes(url.pathname)) {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    rows = rows.map((row) => row.id === `${body.itemType ?? "reference"}:${body.itemId ?? body.sourcePostId}` ? { ...row, ...(url.pathname.endsWith("posts") ? { saved: true } : { userRating: body.rating, viewedAt: body.viewed ? new Date().toISOString() : null }) } : row);
    return send({ ok: true });
  }
  if (url.pathname === "/api/library/drafts") return send({ ok: false, error: "preview_only" }, "application/json", 409);
  if (url.pathname === "/screen") return send('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/bundle.css"><div id="root"></div><script type="module" src="/bundle.js"></script></html>', "text/html");
  return send(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Аврора — проверка ленты</title><style>body{margin:0;background:#e8eaed;font:13px system-ui}nav{padding:12px 16px;display:flex;flex-wrap:wrap;align-items:center;gap:8px;background:white}button{padding:8px 12px;cursor:pointer}span{margin-right:auto;color:#526071}iframe{display:block;width:min(1180px,100%);height:calc(100vh - 64px);margin:0 auto;border:0}</style><nav><span>Предпросмотр · тестовые материалы</span><button data-width="1180">Компьютер</button><button data-width="390">Телефон</button><button data-width="320">320 px</button><button id="add">Добавить новость</button><button id="offline">Сбой сети</button></nav><iframe id="screen" src="/screen" title="Идеи и примеры"></iframe><script>const frame=document.getElementById("screen");document.querySelectorAll("[data-width]").forEach(button=>button.onclick=()=>frame.style.width="min("+button.dataset.width+"px,100%)");document.getElementById("add").onclick=async()=>{await fetch("/fixture/new");frame.contentWindow.dispatchEvent(new Event("focus"));};document.getElementById("offline").onclick=async()=>{await fetch("/fixture/offline");frame.contentWindow.dispatchEvent(new Event("focus"));};</script></html>`, "text/html");
});
server.listen(4319, "127.0.0.1", () => console.log("Library component preview: http://127.0.0.1:4319 (synthetic data only)"));
