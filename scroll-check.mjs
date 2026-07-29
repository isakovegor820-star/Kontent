// Скролл-проверка / на 2000px: каждая секция реальным вьюпортом,
// с паузой на whileInView-анимации.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const EXE =
  "/Users/egor/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = "http://localhost:3000";
const OUT = ".app-v3-shots";
mkdirSync(OUT, { recursive: true });

const errors = [];
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({
  viewport: { width: 2000, height: 1000 },
  deviceScaleFactor: 2,
  locale: "ru-RU",
});
const page = await ctx.newPage();
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console: ${m.text()}`);
});

await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(800);

const anchors = ["how", "compare", "pricing", "faq"];
let i = 0;
for (const id of anchors) {
  i += 1;
  await page.evaluate((aid) => {
    document.getElementById(aid)?.scrollIntoView({ block: "start" });
  }, id);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: `${OUT}/scroll-${i}-${id}.png` });
  console.log(`scroll-${i}-${id} ok`);
}
// футер
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await page.waitForTimeout(1100);
await page.screenshot({ path: `${OUT}/scroll-5-footer.png` });
console.log("scroll-5-footer ok");

await browser.close();
if (errors.length) {
  console.log("\nERRORS:");
  for (const e of errors) console.log(" -", e);
  process.exit(1);
}
console.log("\nSCROLL CHECK DONE");
