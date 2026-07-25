// Профиль канала — структурированное «что ИИ знает об этом бизнесе».
//
// Зачем отдельный модуль: база знаний стала невидимой. Человек больше не заполняет её
// руками — при подключении канала ИИ сам читает посты и вытаскивает профиль (ниша, темы,
// услуги, цены, тон, табу), а человек только проверяет. Не прочиталось (канал приватный,
// постов мало) — тот же профиль собирается из короткого интервью.
//
// Файл чистый (без fetch/БД) и общий: его импортируют и TS-роуты Next.js
// (api/knowledge/extract-profile), и .mjs-воркер (еженедельное обновление профилей).
// Типы для TS — рядом в channel-profile.d.mts (именно .d.mts: при moduleResolution bundler
// типы из .d.ts рядом с .mjs не подхватываются, уже ловили TS2305).

// Поля профиля. Порядок = порядок показа на экране подтверждения онбординга.
export const PROFILE_FIELDS = [
  { key: "niche", label: "Ниша", hint: "О чём канал, одной фразой" },
  { key: "topics", label: "Основные темы", hint: "Через запятую, до пяти" },
  { key: "services", label: "Услуги и продукты", hint: "Что предлагаешь или продаёшь" },
  { key: "prices", label: "Цены и сроки", hint: "С цифрами — ИИ не станет их выдумывать" },
  { key: "audience", label: "Аудитория", hint: "Кто читает канал" },
  { key: "tone", label: "Тон", hint: "Как общаешься: дружелюбно, экспертно, с юмором…" },
  { key: "taboos", label: "Табу", hint: "О чём не пишешь и чего не обещаешь" },
  { key: "goal", label: "Цель канала", hint: "Продажи, личный бренд, трафик, комьюнити" },
];

// Потолки — защита от «модель выдала простыню» и от случайной вставки документа в поле.
const CAPS = { niche: 220, topic: 60, topics: 5, text: 600 };

export function emptyProfile() {
  return { niche: "", topics: [], services: "", prices: "", audience: "", tone: "", taboos: "", goal: "" };
}

const asStr = (v, cap) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, cap);

/** Приводит любой вход (ответ модели, тело PUT-запроса) к каноничному профилю. */
export function normalizeProfile(raw) {
  const p = emptyProfile();
  if (!raw || typeof raw !== "object") return p;
  p.niche = asStr(raw.niche, CAPS.niche);
  p.services = asStr(raw.services, CAPS.text);
  p.prices = asStr(raw.prices, CAPS.text);
  p.audience = asStr(raw.audience, CAPS.text);
  p.tone = asStr(raw.tone, 120);
  p.taboos = asStr(raw.taboos, CAPS.text);
  p.goal = asStr(raw.goal, 160);
  // topics терпим и к массиву, и к строке через запятую — модели отвечают по-разному.
  const list = Array.isArray(raw.topics) ? raw.topics : String(raw.topics ?? "").split(/[;,]/);
  p.topics = list.map((t) => asStr(t, CAPS.topic)).filter(Boolean).slice(0, CAPS.topics);
  return p;
}

/** Правда ли, что в профиле есть хоть что-то полезное (пустышку сохранять нельзя). */
export function isMeaningfulProfile(p) {
  return !!(p && (p.niche || p.services || p.topics?.length));
}

/**
 * Промпт извлечения: по свежим постам канала собрать профиль СТРОГО в JSON.
 * Просим пустые строки вместо догадок — профиль ляжет в базу знаний как ФАКТЫ,
 * и выдуманная здесь цена потом «подтвердит» саму себя в постах (кольцо вранья).
 */
export function buildExtractionMessages(channelTitle, posts) {
  const system =
    "Ты — аналитик Telegram-каналов. По постам канала составляешь его структурированный " +
    "профиль для ИИ-редактора, который будет писать новые посты. Отвечаешь СТРОГО одним " +
    "JSON-объектом: без markdown, без пояснений, без обёрток вида «Вот JSON:».";

  const sample = posts
    .slice(0, 15)
    .map((t, i) => `${i + 1}. ${String(t).replace(/\s+/g, " ").trim().slice(0, 500)}`)
    .join("\n");

  const user =
    `Вот последние посты канала «${channelTitle || "без названия"}»:\n\n${sample}\n\n` +
    "Составь профиль канала строго в таком JSON:\n" +
    '{"niche":"ниша одной фразой","topics":["до 5 основных тем"],"services":"что автор предлагает или продаёт","prices":"цены и сроки с цифрами","audience":"кто читает канал","tone":"как автор общается, 2-4 слова","taboos":"о чём НЕ пишет и чего не обещает","goal":"зачем канал: продажи, личный бренд, трафик"}\n\n' +
    "Правила:\n" +
    "— пиши только то, что прямо следует из постов; не видно — оставь пустую строку, НЕ выдумывай;\n" +
    "— цены и сроки переноси как есть, вместе с цифрами;\n" +
    "— всё по-русски и кратко.";

  return { system, user };
}

/**
 * Разбор ответа модели в профиль. Терпим к обёрткам («Вот JSON:», ```json …```):
 * вырезаем первый сбалансированный объект от первой «{» до последней «}».
 * Возвращает null, если JSON не нашёлся или профиль вышел пустым (считаем сбоем —
 * вызывающий покажет человеку интервью, а не пустую форму).
 */
export function parseProfile(aiText) {
  const s = String(aiText || "");
  const from = s.indexOf("{");
  const to = s.lastIndexOf("}");
  if (from < 0 || to <= from) return null;
  let raw;
  try {
    raw = JSON.parse(s.slice(from, to + 1));
  } catch {
    return null;
  }
  const p = normalizeProfile(raw);
  // Ниша — минимальный признак, что разбор удался. Остальное может быть пустым честно.
  return p.niche ? p : null;
}

/**
 * Профиль → текст для базы знаний. КАЖДОЕ поле — отдельный абзац через пустую строку:
 * индексатор режет источник ровно по пустым строкам («один кусок = одна мысль»), поэтому
 * цены никогда не склеятся с нишей в один мутный вектор.
 */
export function profileToSourceText(p) {
  const parts = [];
  if (p.niche) parts.push(`Ниша канала: ${p.niche}`);
  if (p.goal) parts.push(`Цель канала: ${p.goal}`);
  if (p.topics?.length) parts.push(`Основные темы канала: ${p.topics.join(", ")}`);
  if (p.services) parts.push(`Услуги и продукты: ${p.services}`);
  if (p.prices) parts.push(`Цены и сроки: ${p.prices}`);
  if (p.audience) parts.push(`Аудитория канала: ${p.audience}`);
  if (p.tone) parts.push(`Тон общения автора: ${p.tone}`);
  if (p.taboos) parts.push(`О чём канал НЕ пишет и чего НЕ обещает: ${p.taboos}`);
  return parts.join("\n\n");
}

/**
 * Ответы интервью (fallback, когда канал не прочитался) → тот же профиль.
 * Дальше пути сходятся: профиль из постов и профиль из ответов живут одинаково.
 */
export function profileFromInterview(a) {
  return normalizeProfile({
    niche: a?.about,
    services: a?.services,
    prices: a?.prices,
    taboos: a?.taboos,
    tone: a?.tone,
    goal: a?.goal,
  });
}
