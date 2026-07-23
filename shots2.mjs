// Скриншоты API-страниц с моками: разведка, тренды, автопилот, аналитика.
// Запуск: node shots2.mjs (нужен dev-сервер на :3000)
import { chromium } from "playwright-core";

const EXE =
  "/Users/egor/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const BASE = "http://localhost:3000";
const OUT = "/Users/egor/mvp and prod/presentation-assets";

const CHANNEL = { id: 1, network: "tg", title: "Кофе и код", handle: "@coffee_and_code", is_active: true };

const COMPETITORS = [
  {
    id: 11, handle: "svaril_sam", title: "Сварил сам", subscribers: 12400,
    status: "ready", last_error: null, collected_at: new Date().toISOString(), auto_added: false,
    posts_count: 96, avg_views: 5300, median_views: 4900, with_views: 94, hits_count: 3, thin_data: false,
  },
  {
    id: 12, handle: "zerno_k_zernu", title: "Зерно к зерну", subscribers: 8900,
    status: "ready", last_error: null, collected_at: new Date().toISOString(), auto_added: true,
    posts_count: 61, avg_views: 3100, median_views: 2800, with_views: 60, hits_count: 1, thin_data: false,
  },
  {
    id: 13, handle: "coffee_geek_ru", title: "Кофейный гик", subscribers: 21300,
    status: "ready", last_error: null, collected_at: new Date().toISOString(), auto_added: false,
    posts_count: 142, avg_views: 9800, median_views: 9100, with_views: 140, hits_count: 5, thin_data: false,
  },
];

const TRENDS = {
  status: {
    competitors: 3, ready: 3, pending: 0, error: 0, posts: 299,
    lastCollectedAt: new Date(Date.now() - 42 * 60000).toISOString(),
    matureHours: 24, minMature: 20, waiting: 2, niche: "домашний кофе и кофейные гаджеты",
  },
  competitors: COMPETITORS.map((c) => ({
    id: c.id, handle: c.handle, title: c.title, subscribers: c.subscribers,
    status: c.status, lastError: null, category: null, posts: c.posts_count,
    median: c.median_views, matured: c.posts_count - 4, link: `https://t.me/${c.handle}`,
  })),
  items: [
    {
      id: 101, competitorId: 11, handle: "svaril_sam", competitorTitle: "Сварил сам",
      category: null, msgId: 412, photoUrl: null, media: "text",
      text: "Почему твой кофе горчит? Дело не в зёрнах, а в помоле. Показываю за 40 секунд, как это чинится без новой кофемолки.",
      views: 41200, reactions: 1830, postedAt: new Date(Date.now() - 26 * 3600e3).toISOString(),
      median: 4900, ratio: 8.4,
    },
    {
      id: 102, competitorId: 12, handle: "zerno_k_zernu", competitorTitle: "Зерно к зерну",
      category: null, msgId: 388, photoUrl: null, media: "text",
      text: "С чего начинается твоё утро? У меня — со скрипа кофемолки, который ненавидит вся семья. Расскажите про свой ритуал.",
      views: 26800, reactions: 2140, postedAt: new Date(Date.now() - 49 * 3600e3).toISOString(),
      median: 2800, ratio: 9.6,
    },
    {
      id: 103, competitorId: 13, handle: "coffee_geek_ru", competitorTitle: "Кофейный гик",
      category: null, msgId: 977, photoUrl: null, media: "photo",
      text: "Купил зёрна за 400 рублей и за 2400. Сварил вслепую. Угадал не с первого раза — рассказываю, в чём подвох.",
      views: 43500, reactions: 1560, postedAt: new Date(Date.now() - 70 * 3600e3).toISOString(),
      median: 9100, ratio: 4.8,
    },
    {
      id: 104, competitorId: 11, handle: "svaril_sam", competitorTitle: "Сварил сам",
      category: null, msgId: 401, photoUrl: null, media: "text",
      text: "5 ошибок, из-за которых ты переплачиваешь за зёрна вдвое. Сохрани, чтобы не забыть перед следующей закупкой.",
      views: 18900, reactions: 940, postedAt: new Date(Date.now() - 96 * 3600e3).toISOString(),
      median: 4900, ratio: 3.9,
    },
  ],
};

const DOSSIER = {
  competitor: {
    id: 11, handle: "svaril_sam", title: "Сварил сам", subscribers: 12400,
    status: "ready", lastError: null, collectedAt: new Date().toISOString(),
    link: "https://t.me/svaril_sam",
  },
  stats: {
    postsCount: 96, withViews: 94, avgViews: 5300, medianViews: 4900,
    erPct: 4.2, reachPct: 43, perWeek: 6.5, bestHour: 10, growth: 380,
    thinData: false, thinReason: null,
  },
  rhythm: {
    byWeekday: [
      { day: 1, posts: 18, avgViews: 5100 }, { day: 2, posts: 14, avgViews: 4800 },
      { day: 3, posts: 16, avgViews: 5600 }, { day: 4, posts: 15, avgViews: 5200 },
      { day: 5, posts: 13, avgViews: 4900 }, { day: 6, posts: 11, avgViews: 6100 },
      { day: 0, posts: 9, avgViews: 5300 },
    ],
    byHour: [
      { hour: 8, posts: 22, avgViews: 5800 }, { hour: 10, posts: 26, avgViews: 6400 },
      { hour: 12, posts: 14, avgViews: 4700 }, { hour: 15, posts: 10, avgViews: 4200 },
      { hour: 19, posts: 16, avgViews: 5100 }, { hour: 21, posts: 8, avgViews: 4600 },
    ],
  },
  mediaMix: [
    { media: "text", label: "Текст", posts: 54, share: 56, avgViews: 4800 },
    { media: "photo", label: "Фото", posts: 33, share: 34, avgViews: 5900 },
    { media: "video", label: "Видео", posts: 9, share: 10, avgViews: 7200 },
  ],
  lengthBuckets: [
    { label: "До 500 знаков", posts: 41, avgViews: 5300 },
    { label: "500–1000", posts: 34, avgViews: 5600 },
    { label: "1000+", posts: 21, avgViews: 4400 },
  ],
  hitAnatomy: {
    count: 3, avgLen: 420, restAvgLen: 640,
    media: { media: "text", label: "Текст", count: 2 },
    hours: [8, 10, 10], avgRatio: 6.1,
  },
  subscriberSeries: Array.from({ length: 14 }, (_, i) => ({
    date: new Date(Date.now() - (13 - i) * 86400e3).toISOString().slice(0, 10),
    subscribers: 11800 + i * 45 + (i % 3) * 20,
  })),
  topPosts: [
    { msgId: 412, text: "Почему твой кофе горчит? Дело не в зёрнах, а в помоле. Показываю за 40 секунд.", views: 41200, media: "text", isHit: true, ratio: 8.4, postedAt: new Date(Date.now() - 26 * 3600e3).toISOString(), link: "https://t.me/svaril_sam/412" },
    { msgId: 377, text: "Разобрал на части свою любимую турку. Что внутри и почему она варит лучше новой.", views: 29400, media: "photo", isHit: true, ratio: 6.0, postedAt: new Date(Date.now() - 200 * 3600e3).toISOString(), link: "https://t.me/svaril_sam/377" },
    { msgId: 401, text: "5 ошибок, из-за которых ты переплачиваешь за зёрна вдвое.", views: 18900, media: "text", isHit: true, ratio: 3.9, postedAt: new Date(Date.now() - 96 * 3600e3).toISOString(), link: "https://t.me/svaril_sam/401" },
    { msgId: 355, text: "Один день в кофейне без монтажа. Всё пошло не так с 7:14 утра.", views: 12400, media: "video", isHit: false, ratio: 2.5, postedAt: new Date(Date.now() - 300 * 3600e3).toISOString(), link: "https://t.me/svaril_sam/355" },
  ],
  available: { views: true, reactions: true, reposts: false, comments: false },
  aiInsight: "«Сварил сам» растёт на коротких практичных разборах утром: посты до 500 знаков в 8–10 утра стабильно обходят его норму в 2–3 раза. Залетают темы «ошибка → быстрый фикс». Видео редкое, но даёт максимальный охват — раз в две недели стоит повторять.",
};

const AUTOPILOT = {
  settings: { enabled: true, mode: "confirm", post_frequency: 5, approvals_streak: 3 },
  plan: {
    id: 7, week_start: "2026-07-20", status: "active", rules: null,
    created_at: new Date(Date.now() - 2 * 86400e3).toISOString(),
    items: [
      {
        i: 0, scheduledAt: "2026-07-20T08:00:00.000Z", topic: "Утренний ритуал: скрип кофемолки",
        rubric: "Личное", status: "published",
        draft: "С чего начинается твоё утро? У меня — со скрипа кофемолки, который ненавидит вся семья. Но без него день не начинается.",
        sources: [{ id: 3, text: "Автор мелет зёрна вручную каждое утро с 2019 года" }],
      },
      {
        i: 1, scheduledAt: "2026-07-21T12:00:00.000Z", topic: "Разбор: что внутри турки за 900 ₽",
        rubric: "Разбор", status: "published",
        draft: "Разобрал на части свою любимую турку. Показываю, что там внутри и почему она варит лучше новой за 4 000.",
        sources: [{ id: 7, text: "Турка медная, 350 мл, куплена в 2022" }],
      },
      {
        i: 2, scheduledAt: "2026-07-23T10:00:00.000Z", topic: "Почему кофе горчит: быстрый фикс за 40 секунд",
        rubric: "Практика", status: "approved",
        draft: "Почему твой кофе горчит? Дело не в зёрнах, а в помоле. Три признака и быстрый фикс — показываю за 40 секунд.",
        sources: [{ id: 12, text: "Помол для турки — «в пыль», тоньше эспрессо" }],
      },
      {
        i: 3, scheduledAt: "2026-07-24T08:00:00.000Z", topic: "Вопрос подписчикам: кофе после 18:00?",
        rubric: "Вовлечение", status: "approved",
        draft: "Вечерний вопрос: ты пьёшь кофе после 18:00? Я — да, и сплю прекрасно. Кажется, дело не в кофеине. Расскажи, как у тебя.",
        sources: [],
      },
      {
        i: 4, scheduledAt: "2026-07-25T13:00:00.000Z", topic: "5 ошибок при покупке зёрен",
        rubric: "Практика", status: "pending",
        draft: "5 ошибок, из-за которых ты переплачиваешь за зёрна вдвое. Сохрани, чтобы не забыть перед следующей закупкой.",
        sources: [{ id: 9, text: "Цена speciality-лота — от 1 800 ₽/кг" }],
        invented: ["«9 из 10 покупателей не читают дату обжарки» — цифры нет в базе"],
      },
      {
        i: 5, scheduledAt: "2026-07-26T11:30:00.000Z", topic: "Честный анти-обзор: дорогие зёрна",
        rubric: "Мнение", status: "pending",
        draft: "Купил дорогое — вернулся к дешёвому. Честный анти-обзор без рекламы: когда переплата за зёрна не имеет смысла.",
        sources: [],
      },
    ],
  },
  hasChannel: true,
  brief: {
    niche: "домашний кофе и кофейные гаджеты",
    audience: "люди 25–40, которые варят кофе дома и хотят лучше, но без снобизма",
    rubrics: ["Личное", "Разбор", "Практика", "Вовлечение", "Мнение"],
    goal: "собрать лояльную аудиторию и продавать свой дроп кофе",
    cta: "подписка на канал",
    taboo: "политика, реклама растворимого кофе",
    ready: true, source: "ai",
  },
  briefReady: true,
  channels: [{ id: 1, title: "Кофе и код", handle: "@coffee_and_code" }],
  channelId: 1,
};

const STATS = {
  hasChannel: true,
  channelTitle: "Кофе и код",
  latestSubs: 3412,
  growth7d: 87,
  subscriberSeries: Array.from({ length: 14 }, (_, i) => ({
    snapshot_date: new Date(Date.now() - (13 - i) * 86400e3).toISOString().slice(0, 10),
    subscribers: 3120 + i * 22 + (i === 10 ? 40 : 0),
  })),
  posts: [
    { id: 55, text: "Утро начинается не с кофе. Оно начинается с того, что ты забыл вчера помыть воронку. Знакомо?", published_at: new Date(Date.now() - 2 * 86400e3).toISOString(), stats_state: "ok", views: 9100, reactions: 412 },
    { id: 54, text: "Разобрал на части свою любимую турку. Показываю, что там внутри.", published_at: new Date(Date.now() - 3 * 86400e3).toISOString(), stats_state: "ok", views: 4400, reactions: 231 },
    { id: 53, text: "Купил зёрна за 400 рублей и за 2400. Сварил вслепую.", published_at: new Date(Date.now() - 5 * 86400e3).toISOString(), stats_state: "ok", views: 11700, reactions: 689 },
    { id: 52, text: "Подборка: 5 кофеен Москвы, где действительно умеют варить фильтр.", published_at: new Date(Date.now() - 6 * 86400e3).toISOString(), stats_state: "ok", views: 6800, reactions: 305 },
    { id: 51, text: "Один день в кофейне без монтажа. Всё пошло не так с 7:14 утра.", published_at: new Date(Date.now() - 8 * 86400e3).toISOString(), stats_state: "ok", views: 8300, reactions: 377 },
    { id: 50, text: "Опрос: какую воду ты используешь? Бутилированную, фильтр или из-под крана.", published_at: new Date(Date.now() - 9 * 86400e3).toISOString(), stats_state: "ok", views: 3900, reactions: 890 },
  ],
  totals: { published: 6, totalViews: 44200, avgViews: 7367 },
  bestPost: { text: "Купил зёрна за 400 рублей и за 2400. Сварил вслепую.", views: 11700 },
  insight: "Лучше всего заходят честные сравнения «дорого vs дёшево» и личные истории утра. Посты в 8:00 собирают на 40% больше просмотров, чем вечерние. Опросы — твой скрытый чемпион по реакциям: ставь их раз в неделю.",
  available: { views: true, reactions: true, reach: false, comments: false },
  collectedAt: new Date(Date.now() - 18 * 60000).toISOString(),
};

const json = (data) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(data),
});

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

// Логин под уже созданным аккаунтом
await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
await page.evaluate(async () => {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "shots@aurora-app.ru", password: "DemoPass123!" }),
  });
  return r.status;
});
await page.goto(`${BASE}/app/calendar`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("aurora.state.v1") || "{}");
  s.onboarded = true;
  localStorage.setItem("aurora.state.v1", JSON.stringify(s));
});

async function shot(name, ms = 2500) {
  await page.waitForTimeout(ms);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log("saved", name);
}

// --- Конкуренты: список ---
await page.route("**/api/channels**", (r) => r.fulfill(json({ channels: [CHANNEL] })));
await page.route("**/api/competitors/suggestions**", (r) => r.fulfill(json({ suggestions: [] })));
await page.route("**/api/competitors?**", (r) => r.fulfill(json({ competitors: COMPETITORS, limit: 20 })));
await page.route("**/api/competitors", (r) => r.fulfill(json({ competitors: COMPETITORS, limit: 20 })));
await page.route("**/api/competitors/11", (r) => r.fulfill(json(DOSSIER)));
await page.goto(`${BASE}/app/competitors`, { waitUntil: "domcontentloaded" });
await shot("05-competitors", 3500);

// --- Конкурент: досье ---
await page.goto(`${BASE}/app/competitors/11`, { waitUntil: "domcontentloaded" });
await shot("06-competitor-dossier", 4000);

// --- Тренды ---
await page.route("**/api/trends**", (r) => {
  if (r.request().method() === "GET") return r.fulfill(json(TRENDS));
  return r.fulfill(json({ ok: true, queued: 0 }));
});
await page.goto(`${BASE}/app/trends`, { waitUntil: "domcontentloaded" });
await shot("04-trends", 3500);

// --- Автопилот ---
await page.route("**/api/autopilot**", (r) => r.fulfill(json(AUTOPILOT)));
await page.goto(`${BASE}/app/autopilot`, { waitUntil: "domcontentloaded" });
await shot("08-autopilot", 4000);

// --- Аналитика ---
await page.route("**/api/stats?**", (r) => r.fulfill(json(STATS)));
await page.route("**/api/stats", (r) => r.fulfill(json(STATS)));
await page.goto(`${BASE}/app/analytics`, { waitUntil: "domcontentloaded" });
await shot("09-analytics", 4000);

await browser.close();
console.log("done");
