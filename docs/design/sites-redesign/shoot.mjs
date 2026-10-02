// Скриншоты прототипа: node docs/design/sites-redesign/shoot.mjs
// Требуется Chrome (playwright-core запускает установленный браузер, канал "chrome").
import { chromium } from "playwright-core";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "screens");
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });

// Десктоп: пять экранов раздела.
const page = await browser.newPage({ viewport: { width: 1610, height: 1048 } });
await page.goto(pathToFileURL(resolve(here, "index.html")).href, { waitUntil: "load" });
await page.addStyleTag({ content: "html{scroll-behavior:auto!important}" });
const tabs = await page.$$eval("[data-tab]", (nodes) => nodes.map((node) => node.dataset.tab));
for (const [index, tab] of tabs.entries()) {
  if (index > 0) { await page.click(`[data-tab="${tab}"]`); await page.waitForTimeout(150); }
  await page.screenshot({ path: `${outDir}/${index + 1}-${tab}.png` });
  await page.screenshot({ path: `${outDir}/${index + 1}-${tab}-full.png`, fullPage: true });
  console.log("ok", tab);
}

// Мобильный: как раздел выглядит на телефоне.
const phone = await browser.newPage({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2 });
await phone.goto(pathToFileURL(resolve(here, "index.html")).href, { waitUntil: "load" });
await phone.addStyleTag({ content: "html{scroll-behavior:auto!important}" });
await phone.click('[data-tab="materials"]');
await phone.waitForTimeout(200);
await phone.screenshot({ path: `${outDir}/6-mobile-materials.png` });
console.log("ok mobile");

await browser.close();
