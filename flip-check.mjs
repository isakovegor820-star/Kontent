// Проверка переключения лендинга: / стал v3, /v3 — алиас, /old — архив.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const EXE =
  "/Users/egor/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = "http://localhost:3000";
const OUT = ".app-v3-shots";
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({ executablePath: EXE, headless: true });

async function shot(tag, url, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ru-RU" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${tag}] console: ${m.text()}`);
  });
  const res = await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const title = await page.title();
  console.log(`${tag} ${url} -> ${res.status()} | ${title}`);
  await page.screenshot({ path: `${OUT}/flip-${tag}.png` });
  await ctx.close();
}

await shot("root", "/", { width: 1440, height: 900 });
await shot("v3", "/v3", { width: 1440, height: 900 });
await shot("old", "/old", { width: 1440, height: 900 });
await shot("root-mobile", "/", { width: 390, height: 844 });

await browser.close();
if (errors.length) {
  console.log("\nERRORS:");
  for (const e of errors) console.log(" -", e);
  process.exit(1);
}
console.log("\nFLIP CHECK DONE");
