// QA-прогон платформы после рескина app-v3: логин, все экраны, два вьюпорта.
// Паттерн — как у shots.mjs: playwright-core + кэшированный Chromium.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const EXE =
  "/Users/egor/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = "http://localhost:3000";
const OUT = ".app-v3-shots";
mkdirSync(OUT, { recursive: true });

const PAGES = [
  ["calendar", "/app/calendar"],
  ["composer", "/app/composer"],
  ["studio", "/app/studio"],
  ["autopilot", "/app/autopilot"],
  ["library", "/app/library"],
  ["rss", "/app/rss"],
  ["recon", "/app/recon"],
  ["analytics", "/app/analytics"],
  ["settings", "/app/settings"],
  ["onboarding", "/app/onboarding"],
];

const browser = await chromium.launch({ executablePath: EXE, headless: true });

// --- логин через API, куку кладём в контекст ---
async function authedContext(viewport) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    locale: "ru-RU",
  });
  // логин с ретраями: rate-limit (429) отвечает после частых прогонов
  let res;
  for (let attempt = 0; attempt < 5; attempt++) {
    res = await ctx.request.post(`${BASE}/api/auth/login`, {
      data: { email: "shots@aurora-app.ru", password: "DemoPass123!" },
    });
    if (res.ok()) break;
    if (res.status() !== 429 || attempt === 4)
      throw new Error(`login failed: ${res.status()}`);
    console.log(`login 429, жду ${(attempt + 1) * 15}s…`);
    await new Promise((r) => setTimeout(r, (attempt + 1) * 15000));
  }
  return ctx;
}

const errors = [];

async function sweep(tag, viewport, pages) {
  const ctx = await authedContext(viewport);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${tag}] console: ${m.text()}`);
  });
  // Онбординг — локальный флаг в localStorage (aurora.state.v1). Первый заход
  // сеет демо-данные; помечаем мастер пройденным, чтобы шелл пустил на экраны.
  await page.goto(`${BASE}/app/calendar`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const raw = localStorage.getItem("aurora.state.v1");
    if (!raw) throw new Error("store не засеялся в localStorage");
    const s = JSON.parse(raw);
    s.onboarded = true;
    localStorage.setItem("aurora.state.v1", JSON.stringify(s));
  });
  for (const [name, url] of pages) {
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${OUT}/${tag}-${name}.png` });
    console.log(`${tag}-${name} ok`);
  }
  await ctx.close();
}

// регистрация — без логина (редиректнуло бы в приложение)
async function publicShots() {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    locale: "ru-RU",
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[public] pageerror: ${e.message}`));
  await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${OUT}/d-register.png` });
  console.log("d-register ok");
  await ctx.close();
}

await publicShots();
await sweep("d", { width: 1440, height: 900 }, PAGES);
await sweep(
  "m",
  { width: 390, height: 844 },
  [PAGES[0], PAGES[1], PAGES[2], PAGES[6], PAGES[8]], // calendar, composer, studio, recon, settings
);

await browser.close();

if (errors.length) {
  console.log("\nERRORS:");
  for (const e of errors) console.log(" -", e);
  process.exit(1);
}
console.log("\nAPP QA DONE");
