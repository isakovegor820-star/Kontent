// Проверка широких экранов: колонка 1440px + поля-метки.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const EXE =
  "/Users/egor/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = "http://localhost:3000";
const OUT = ".app-v3-shots";
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({ executablePath: EXE, headless: true });

async function shot(tag, viewport, fullPage = false) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, locale: "ru-RU" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${tag}] console: ${m.text()}`);
  });
  const res = await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  console.log(`${tag} -> ${res.status()}`);
  await page.screenshot({ path: `${OUT}/wide-${tag}.png`, fullPage });
  await ctx.close();
}

await shot("2000-hero", { width: 2000, height: 1000 });
await shot("2000-full", { width: 2000, height: 1000 }, true);
await shot("1440-hero", { width: 1440, height: 900 });
await shot("390-mobile", { width: 390, height: 844 });

await browser.close();
if (errors.length) {
  console.log("\nERRORS:");
  for (const e of errors) console.log(" -", e);
  process.exit(1);
}
console.log("\nWIDE CHECK DONE");
