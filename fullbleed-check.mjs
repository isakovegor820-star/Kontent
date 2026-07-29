// Full-bleed проверка: 2560 (2K) / 2000 / 1440 / 390 — hero и ключевые секции.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const EXE =
  "/Users/egor/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = "http://localhost:3000";
const OUT = ".app-v3-shots";
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({ executablePath: EXE, headless: true });

async function shot(tag, width, anchor) {
  const ctx = await browser.newContext({
    viewport: { width, height: 1000 },
    deviceScaleFactor: 1,
    locale: "ru-RU",
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[${tag}] console: ${m.text()}`);
  });
  const res = await page.goto(`${BASE}/${anchor}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1100);
  await page.screenshot({ path: `${OUT}/${tag}.png` });
  console.log(`${tag}: ${res.status()}`);
  await ctx.close();
}

await shot("fb-2560-hero", 2560, "");
await shot("fb-2560-pricing", 2560, "#pricing");
await shot("fb-2560-how", 2560, "#how");
await shot("fb-2000-hero", 2000, "");
await shot("fb-1440-hero", 1440, "");
await shot("fb-390-mobile", 390, "");

await browser.close();
if (errors.length) {
  console.log("ERRORS:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("FULLBLEED QA OK");
