// Скриншоты платформы для презентации: Playwright-core + кешированный Chromium.
// Запуск: node shots.mjs (нужен работающий dev-сервер на :3000)
import { chromium } from "playwright-core";

const EXE =
  "/Users/egor/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = "http://localhost:3000";
const OUT = "/Users/egor/mvp and prod/presentation-assets";

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "light",
  locale: "ru-RU",
});
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("aurora.theme", "light");
  } catch {}
});
const page = await ctx.newPage();

async function shot(name, ms = 2000) {
  await page.waitForTimeout(ms);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("saved", name);
}

// 1. Лендинг — hero
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await shot("01-landing-hero", 3500);

// 2. Экран входа — до авторизации
await page.goto(`${BASE}/register`, { waitUntil: "domcontentloaded" });
await shot("03-register");

// 3. Лендинг — секция сравнения с конкурентами
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
try {
  await page
    .locator("text=/конкурент|SMMplanner|LiveDune/i")
    .first()
    .scrollIntoViewIfNeeded();
} catch {}
await shot("01b-landing-compare", 1500);

// Регистрация демо-аккаунта (409 — уже есть, тогда логин)
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
const status = await page.evaluate(async () => {
  const r = await fetch("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "shots@aurora-app.ru",
      password: "DemoPass123!",
      name: "Егор",
    }),
  });
  if (r.status === 409) {
    const l = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "shots@aurora-app.ru", password: "DemoPass123!" }),
    });
    return l.status;
  }
  return r.status;
});
console.log("auth status", status);

// Прогреваем стор и помечаем онбординг пройденным
await page.goto(`${BASE}/app/calendar`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("aurora.state.v1") || "{}");
  s.onboarded = true;
  localStorage.setItem("aurora.state.v1", JSON.stringify(s));
});

// 4. Календарь — главный экран
await page.goto(`${BASE}/app/calendar`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=Очередь без дат", { timeout: 15000 }).catch(() => {});
await shot("02-calendar", 2500);

// 5. Тренды — «Сними это»
await page.goto(`${BASE}/app/trends`, { waitUntil: "domcontentloaded" });
await shot("04-trends", 3000);

// 6. Конкуренты
await page.goto(`${BASE}/app/competitors`, { waitUntil: "domcontentloaded" });
await shot("05-competitors", 3000);

// 7. Досье конкурента — клик по первой карточке
try {
  const card = page.locator('a[href^="/app/competitors/"]').first();
  await card.click({ timeout: 5000 });
  await page.waitForURL(/\/app\/competitors\/.+/, { timeout: 8000 });
  await shot("06-competitor-dossier", 3000);
} catch (e) {
  console.log("dossier failed", e.message);
}

// 8. ИИ-студия
await page.goto(`${BASE}/app/studio`, { waitUntil: "domcontentloaded" });
await shot("07-studio", 3000);

// 9. Автопилот
await page.goto(`${BASE}/app/autopilot`, { waitUntil: "domcontentloaded" });
await shot("08-autopilot", 3500);

// 10. Аналитика
await page.goto(`${BASE}/app/analytics`, { waitUntil: "domcontentloaded" });
await shot("09-analytics", 3000);

// 11. Редактор поста
await page.goto(`${BASE}/app/composer`, { waitUntil: "domcontentloaded" });
await shot("10-composer", 3000);

await browser.close();
console.log("done");
