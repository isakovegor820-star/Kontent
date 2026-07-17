// Демо-данные. Реалистичные, на русском, в тоне ТЗ 7.5 (просто и дружелюбно).
// Даты считаются относительно «сейчас» — данные всегда выглядят живыми.

import type {
  AppState,
  AutopilotSlot,
  Channel,
  Competitor,
  Post,
  Settings,
  Trend,
} from "./types";
import { addDays, atTime, seeded, startOfWeek, uid } from "./utils";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();

/* ------------------------------------------------------------- КАНАЛЫ */

export const seedChannels = (): Channel[] => [
  {
    id: "ch_tg",
    network: "tg",
    name: "Кофе и код",
    handle: "@coffee_and_code",
    subscribers: 4820,
    connected: true,
  },
  {
    id: "ch_vk",
    network: "vk",
    name: "Кофе и код",
    handle: "vk.com/coffeeandcode",
    subscribers: 2140,
    connected: true,
  },
];

/* -------------------------------------------------------- КОНКУРЕНТЫ */

export const seedCompetitors = (): Competitor[] => [
  {
    id: "cmp_1",
    name: "Сварил сам",
    handle: "@svaril_sam",
    network: "tg",
    avatarHue: 26,
    subscribers: 38400,
    growth30d: 12.4,
    postsPerWeek: 9,
    er: 7.8,
    medianViews: 9200,
    adSigns: 3,
    aiVerdict:
      "Растут в 3 раза быстрее тебя за счёт коротких видео с рецептами: 4 из 5 их залётов — вертикалка до 40 секунд с крупным планом чашки. Тексты у них слабее твоих, а вот формат — сильнее: попробуй снимать то же самое, но своим голосом.",
    topFormats: [
      { name: "Короткое видео", share: 46, er: 11.2 },
      { name: "Фото + личная история", share: 24, er: 6.4 },
      { name: "Карусель-инструкция", share: 18, er: 5.1 },
      { name: "Текст без медиа", share: 12, er: 2.3 },
    ],
    topTopics: [
      { name: "Рецепты за 60 секунд", share: 32, lift: 3.4 },
      { name: "Ошибки новичков", share: 21, lift: 2.7 },
      { name: "Обзоры техники", share: 19, lift: 1.2 },
      { name: "Личное / закулисье", share: 16, lift: 2.1 },
      { name: "Подборки кофеен", share: 12, lift: 0.8 },
    ],
    mentions: [
      {
        source: "Пикабу",
        tone: "pos",
        text: "Единственный канал про кофе, где не льют воду. Подписался.",
        date: daysAgo(3),
      },
      {
        source: "VC.ru",
        tone: "neu",
        text: "В обзоре кофейных телеграм-каналов упомянут в первой пятёрке.",
        date: daysAgo(9),
      },
      {
        source: "Отзовик",
        tone: "neg",
        text: "Слишком много рекламы зёрен в последнее время.",
        date: daysAgo(14),
      },
    ],
    bestPosts: [
      {
        id: "cp_1",
        text: "Почему твой кофе горчит? Дело не в зёрнах. Показываю за 40 секунд →",
        views: 71400,
        multiplier: 7.8,
        format: "Короткое видео",
        topic: "Ошибки новичков",
        publishedAt: hoursAgo(6),
      },
      {
        id: "cp_2",
        text: "Купил кофемашину за 300 тысяч. Через месяц вернулся к воронке. Вот почему.",
        views: 42100,
        multiplier: 4.6,
        format: "Фото + личная история",
        topic: "Личное / закулисье",
        publishedAt: daysAgo(4),
      },
      {
        id: "cp_3",
        text: "5 ошибок, из-за которых ты переплачиваешь за зёрна в 2 раза",
        views: 38900,
        multiplier: 4.2,
        format: "Карусель-инструкция",
        topic: "Ошибки новичков",
        publishedAt: daysAgo(7),
      },
    ],
    reachSeries: [5200, 5600, 5400, 6100, 6800, 6400, 7200, 7900, 8400, 8100, 9200, 11800],
    addedAt: daysAgo(21),
    dossierStatus: "ready",
  },
  {
    id: "cmp_2",
    name: "Зерно к зерну",
    handle: "@zerno_k_zernu",
    network: "tg",
    avatarHue: 152,
    subscribers: 21700,
    growth30d: 3.1,
    postsPerWeek: 5,
    er: 5.2,
    medianViews: 6100,
    adSigns: 1,
    aiVerdict:
      "Стабильные, но скучные: почти всё — длинные тексты без медиа, залётов почти нет. Берут глубиной, а не частотой. У них можно подсмотреть темы, но не форматы — форматы у тебя уже лучше.",
    topFormats: [
      { name: "Длинный текст", share: 52, er: 4.8 },
      { name: "Фото + подпись", share: 28, er: 5.4 },
      { name: "Опрос", share: 12, er: 8.9 },
      { name: "Короткое видео", share: 8, er: 7.1 },
    ],
    topTopics: [
      { name: "Обжарка и химия", share: 38, lift: 1.4 },
      { name: "Фермы и происхождение", share: 27, lift: 1.1 },
      { name: "Дегустации", share: 21, lift: 1.6 },
      { name: "Новости индустрии", share: 14, lift: 0.6 },
    ],
    mentions: [
      {
        source: "Telegram-каталог",
        tone: "pos",
        text: "Лучший канал для тех, кто хочет разобраться в обжарке.",
        date: daysAgo(11),
      },
      {
        source: "Reddit r/coffee",
        tone: "neu",
        text: "Русскоязычный канал, переводят их посты иногда.",
        date: daysAgo(20),
      },
    ],
    bestPosts: [
      {
        id: "cp_4",
        text: "Опрос: какую воду ты используешь для заваривания? Результат нас удивил.",
        views: 19400,
        multiplier: 3.2,
        format: "Опрос",
        topic: "Дегустации",
        publishedAt: daysAgo(2),
      },
      {
        id: "cp_5",
        text: "Разбор: что на самом деле значит «средняя обжарка» и почему это обман",
        views: 14800,
        multiplier: 2.4,
        format: "Длинный текст",
        topic: "Обжарка и химия",
        publishedAt: daysAgo(8),
      },
    ],
    reachSeries: [5800, 5900, 6000, 5700, 6200, 6100, 5900, 6300, 6100, 6400, 6200, 6600],
    addedAt: daysAgo(18),
    dossierStatus: "ready",
  },
  {
    id: "cmp_3",
    name: "Кофейня на углу",
    handle: "vk.com/corner_coffee",
    network: "vk",
    avatarHue: 258,
    subscribers: 9300,
    growth30d: 24.8,
    postsPerWeek: 12,
    er: 9.4,
    medianViews: 3100,
    adSigns: 0,
    aiVerdict:
      "Взрывной рост: +24,8% за месяц на маленькой базе. Секрет простой — постят каждый день в 8:00 и всегда задают вопрос в конце. Вовлечённость 9,4% — выше твоей вдвое. Попробуй их приём с вопросом.",
    topFormats: [
      { name: "Фото + вопрос", share: 44, er: 12.1 },
      { name: "Сторис-подборка", share: 26, er: 8.2 },
      { name: "Короткое видео", share: 20, er: 9.8 },
      { name: "Текст", share: 10, er: 3.4 },
    ],
    topTopics: [
      { name: "Утренний ритуал", share: 34, lift: 2.9 },
      { name: "Гости и люди", share: 29, lift: 2.2 },
      { name: "Меню и новинки", share: 24, lift: 1.5 },
      { name: "Закулисье", share: 13, lift: 1.8 },
    ],
    mentions: [
      {
        source: "2ГИС",
        tone: "pos",
        text: "Читаю их VK ради утренних постов, даже не хожу туда.",
        date: daysAgo(5),
      },
    ],
    bestPosts: [
      {
        id: "cp_6",
        text: "Каждое утро мы задаём гостям один вопрос. Сегодня — тебе: с чего начинается твой день?",
        views: 28700,
        multiplier: 9.2,
        format: "Фото + вопрос",
        topic: "Утренний ритуал",
        publishedAt: hoursAgo(14),
      },
    ],
    reachSeries: [1200, 1400, 1300, 1700, 1900, 2200, 2100, 2600, 2900, 2800, 3100, 3900],
    addedAt: daysAgo(6),
    dossierStatus: "ready",
  },
];

/* ------------------------------------------------------------- ТРЕНДЫ */

export const seedTrends = (): Trend[] => [
  {
    id: "tr_1",
    title: "«Почему твой кофе горчит» — разбор ошибки за 40 секунд",
    why: "У «Сварил сам» это видео собрало в 7,8 раза больше обычного. Работает связка: обвинение в первой секунде («ты делаешь это неправильно») + быстрый показ решения. Люди досматривают, потому что боятся оказаться теми, кто ошибается.",
    script: [
      "0–3 сек. Крупный план чашки. Голос: «Твой кофе горчит? Дело не в зёрнах».",
      "3–12 сек. Показываешь помол — слишком мелкий. «Вот виновник».",
      "12–28 сек. Рядом два помола, две чашки, два вкуса. Говоришь простыми словами.",
      "28–40 сек. Итог одной фразой + вопрос в конце: «А ты какой помол ставишь?»",
    ],
    scope: "niche",
    format: "video",
    multiplier: 7.8,
    hook: "«Твой кофе горчит? Дело не в зёрнах.»",
    sourceCompetitorId: "cmp_1",
    sourceName: "Сварил сам",
    detectedAt: hoursAgo(2),
    hue: 26,
  },
  {
    id: "tr_2",
    title: "Утренний вопрос подписчикам — приём на 9,2× охвата",
    why: "«Кофейня на углу» задаёт один простой вопрос каждое утро в 8:00. Комментарии растут → алгоритм поднимает пост. Приём копируется за 5 минут и не требует съёмки.",
    script: [
      "Фото любой — чашка, руки, окно. Снимать не обязательно, подойдёт архив.",
      "Текст: одно наблюдение о утре в 2 предложениях.",
      "Последняя строка — вопрос лично читателю. Без «друзья» и «а как у вас?». Конкретно.",
      "Публиковать в 8:00. Отвечать на первые 10 комментариев в течение часа.",
    ],
    scope: "niche",
    format: "post",
    multiplier: 9.2,
    sourceCompetitorId: "cmp_3",
    sourceName: "Кофейня на углу",
    detectedAt: hoursAgo(9),
    hue: 258,
  },
  {
    id: "tr_3",
    title: "«Купил дорогое — вернулся к дешёвому». Честный анти-обзор",
    why: "Формат разочарования в дорогой покупке залетает во всех нишах: людям нравится, когда кто-то тратит деньги за них и признаёт ошибку. У конкурента — 4,6× охвата.",
    script: [
      "Первый кадр: дорогая вещь. «Отдал за это 300 тысяч».",
      "Секунда 5: «Через месяц вернулся к тому, что стоит 3 тысячи».",
      "Дальше — три честные причины. Без рекламы, без «но вам советую».",
      "Финал: «Не повторяй мою ошибку». Вопрос: «На что ты зря потратился?»",
    ],
    scope: "niche",
    format: "video",
    multiplier: 4.6,
    hook: "«Отдал за это 300 тысяч. Через месяц вернулся к воронке.»",
    sourceCompetitorId: "cmp_1",
    sourceName: "Сварил сам",
    detectedAt: hoursAgo(19),
    hue: 340,
  },
  {
    id: "tr_4",
    title: "Тихий тренд сетей: «один день из жизни» без монтажа",
    why: "Общий тренд Telegram и VK за неделю: сырые, немонтированные вертикалки набирают больше отполированных. Порог входа нулевой — снимаешь телефоном как есть.",
    script: [
      "Снимай подряд весь день, коротко: 5–7 кусков по 3 секунды.",
      "Не монтируй красиво. Склей встык, оставь звук как есть.",
      "Подпись — одна честная строка о том, что было тяжело.",
    ],
    scope: "global",
    format: "video",
    multiplier: 3.1,
    hook: "«7:14. Ещё не открылись, а уже всё пошло не так.»",
    detectedAt: hoursAgo(30),
    hue: 190,
  },
  {
    id: "tr_5",
    title: "Карусель «5 ошибок» — вечнозелёный формат",
    why: "Работает годами и сейчас снова растёт: у конкурента 4,2× охвата. Сохранения выше, чем у видео — люди возвращаются к посту.",
    script: [
      "Слайд 1 — обложка с цифрой. «5 ошибок, из-за которых ты переплачиваешь».",
      "Слайды 2–6 — по одной ошибке, крупный текст, минимум слов.",
      "Слайд 7 — «Сохрани, чтобы не забыть».",
    ],
    scope: "niche",
    format: "carousel",
    multiplier: 4.2,
    sourceCompetitorId: "cmp_1",
    sourceName: "Сварил сам",
    detectedAt: daysAgo(2),
    hue: 152,
  },
  {
    id: "tr_6",
    title: "Опрос вместо поста — самый дешёвый рост ER",
    why: "У «Зерно к зерну» опросы дают ER 8,9% против 4,8% у их текстов. Опрос пишется за минуту и не требует ни съёмки, ни ИИ.",
    script: [
      "Вопрос с 3–4 вариантами. Варианты должны спорить друг с другом.",
      "Через сутки — второй пост с разбором результата. Это второй охват из ничего.",
    ],
    scope: "niche",
    format: "post",
    multiplier: 2.4,
    sourceCompetitorId: "cmp_2",
    sourceName: "Зерно к зерну",
    detectedAt: daysAgo(3),
    hue: 96,
  },
];

/* -------------------------------------------------------------- ПОСТЫ */

export const seedPosts = (): Post[] => {
  const rnd = seeded(42);
  const week = startOfWeek(new Date());
  const posts: Post[] = [];

  // Прошедшие — уже вышли, с цифрами
  const past = [
    {
      d: -6,
      t: "09:00",
      text: "Три года назад я не мог отличить арабику от робусты. Сегодня расскажу, что помогло разобраться быстрее всего — и это не курсы.",
      views: 5240,
      origin: "manual" as const,
    },
    {
      d: -5,
      t: "18:30",
      text: "Самый частый вопрос в личке: «какую кофемолку взять до 10 тысяч?». Отвечаю развёрнуто, чтобы больше не повторяться →",
      views: 6810,
      origin: "ai" as const,
    },
    {
      d: -3,
      t: "08:00",
      text: "Утро начинается не с кофе. Оно начинается с того, что ты забыл вчера помыть воронку. Знакомо?",
      views: 9120,
      origin: "trend" as const,
    },
    {
      d: -2,
      t: "12:00",
      text: "Разобрал на части свою любимую турку. Показываю, что там внутри и почему она варит лучше новой.",
      views: 4380,
      origin: "manual" as const,
    },
    {
      d: -1,
      t: "19:00",
      text: "Купил зёрна за 400 рублей и за 2400. Сварил вслепую. Угадал не с первого раза — рассказываю, в чём подвох.",
      views: 11740,
      origin: "competitor" as const,
    },
  ];

  past.forEach((p, i) => {
    const at = atTime(addDays(week, 3 + p.d), p.t);
    posts.push({
      id: `post_past_${i}`,
      text: p.text,
      networks: i % 3 === 0 ? ["tg"] : ["tg", "vk"],
      scheduledAt: at.toISOString(),
      status: "published",
      origin: p.origin,
      media: i % 2 === 0 ? { kind: "image", label: "Фото", hue: 20 + i * 40 } : null,
      metrics: {
        views: p.views,
        reactions: Math.round(p.views * (0.04 + rnd() * 0.03)),
        comments: Math.round(p.views * (0.006 + rnd() * 0.005)),
        shares: Math.round(p.views * (0.003 + rnd() * 0.004)),
      },
      attempts: 1,
      createdAt: daysAgo(8 - i),
    });
  });

  // Один сбой — честно показываем (ТЗ 5.3, Б3)
  posts.push({
    id: "post_failed",
    text: "Подборка: 5 кофеен Москвы, где действительно умеют варить фильтр. Без рекламы, за свои.",
    networks: ["tg", "vk"],
    scheduledAt: atTime(addDays(week, 2), "14:00").toISOString(),
    status: "failed",
    origin: "manual",
    media: { kind: "image", label: "Подборка", hue: 200 },
    attempts: 3,
    failReason: "VK не ответил. Мы попробовали 3 раза — пост не потерян, можно отправить снова.",
    createdAt: daysAgo(3),
  });

  // Будущие — запланированы
  const future = [
    {
      d: 3,
      t: "10:00",
      text: "Почему твой кофе горчит? Дело не в зёрнах. Показываю за 40 секунд →",
      origin: "trend" as const,
      src: { kind: "trend" as const, id: "tr_1", label: "Залёт у «Сварил сам» ×7,8" },
    },
    {
      d: 3,
      t: "19:00",
      text: "Вечерний вопрос: ты пьёшь кофе после 18:00? Я — да, и сплю прекрасно. Кажется, дело не в кофеине.",
      origin: "ai" as const,
    },
    {
      d: 4,
      t: "08:00",
      text: "С чего начинается твоё утро? У меня — со скрипа кофемолки, который ненавидит вся семья.",
      origin: "trend" as const,
      src: { kind: "trend" as const, id: "tr_2", label: "Приём «утренний вопрос» ×9,2" },
    },
    {
      d: 5,
      t: "13:00",
      text: "5 ошибок, из-за которых ты переплачиваешь за зёрна вдвое. Сохрани, чтобы не забыть.",
      origin: "autopilot" as const,
    },
    {
      d: 6,
      t: "11:30",
      text: "Один день в кофейне без монтажа. Всё пошло не так с 7:14 утра.",
      origin: "autopilot" as const,
    },
  ];

  future.forEach((p, i) => {
    posts.push({
      id: `post_fut_${i}`,
      text: p.text,
      networks: i % 4 === 3 ? ["tg"] : ["tg", "vk"],
      scheduledAt: atTime(addDays(week, p.d), p.t).toISOString(),
      status: "scheduled",
      origin: p.origin,
      sourceRef: p.src,
      media: i % 2 === 0 ? { kind: "video", label: "Вертикалка", hue: 260 + i * 20 } : null,
      createdAt: daysAgo(1),
    });
  });

  // Очередь без дат (ТЗ 5.3)
  posts.push(
    {
      id: "post_q1",
      text: "Как я перестал покупать кофе в кофейнях и начал экономить 8 000 ₽ в месяц. Считаю по-честному.",
      networks: ["tg", "vk"],
      scheduledAt: null,
      status: "queued",
      origin: "ai",
      media: null,
      createdAt: daysAgo(2),
    },
    {
      id: "post_q2",
      text: "Опрос: какую воду ты используешь? Бутилированную, фильтр или из-под крана — и почему.",
      networks: ["tg"],
      scheduledAt: null,
      status: "queued",
      origin: "trend",
      sourceRef: { kind: "trend", id: "tr_6", label: "Опрос — ER 8,9% у «Зерно к зерну»" },
      media: null,
      createdAt: daysAgo(1),
    },
  );

  return posts;
};

/* ---------------------------------------------------------- АВТОПИЛОТ */

export const seedAutopilot = (): AutopilotSlot[] => [
  {
    id: uid("ap"),
    day: 0,
    time: "08:00",
    title: "Утренний вопрос",
    text: "С чего начинается твоё утро? У меня — со скрипа кофемолки, который ненавидит вся семья. Расскажи свой утренний ритуал в комментариях.",
    networks: ["tg", "vk"],
    origin: "trend",
    sourceLabel: "Приём «Кофейни на углу» — ER 12,1%",
    status: "pending",
  },
  {
    id: uid("ap"),
    day: 1,
    time: "19:00",
    title: "Разбор ошибки: горький кофе",
    text: "Твой кофе горчит? Дело не в зёрнах, а в помоле. Показываю за 40 секунд, как это чинится без покупки новой кофемолки.",
    networks: ["tg", "vk"],
    origin: "competitor",
    sourceLabel: "Залёт у «Сварил сам» ×7,8",
    status: "pending",
  },
  {
    id: uid("ap"),
    day: 2,
    time: "12:00",
    title: "Личная история",
    text: "Три года назад я варил кофе в турке из «Ашана» и был счастлив. Сейчас у меня полка железа — а счастья столько же. Вот что я понял.",
    networks: ["tg"],
    origin: "ai",
    status: "pending",
  },
  {
    id: uid("ap"),
    day: 4,
    time: "13:00",
    title: "Карусель «5 ошибок»",
    text: "5 ошибок, из-за которых ты переплачиваешь за зёрна вдвое. Сохрани — пригодится перед следующей покупкой.",
    networks: ["tg", "vk"],
    origin: "trend",
    sourceLabel: "Вечнозелёный формат ×4,2",
    status: "pending",
  },
  {
    id: uid("ap"),
    day: 5,
    time: "11:00",
    title: "День без монтажа",
    text: "Один день в кофейне, снятый как есть. 7:14 — уже всё пошло не так.",
    networks: ["tg", "vk"],
    origin: "trend",
    sourceLabel: "Общий тренд сетей ×3,1",
    status: "pending",
  },
];

/* ---------------------------------------------------------- НАСТРОЙКИ */

export const seedSettings = (): Settings => ({
  mode: "solo",
  autopilotConfirm: true,
  quietHours: { from: "23:00", to: "08:00", enabled: true },
  botLinked: true,
  weeklyReport: true,
  aiDailyLimit: 30,
  aiUsedToday: 7,
  niche: "Кофе, обжарка, домашнее заваривание",
  tone: "Дружелюбный, на «ты», с личными историями и без пафоса",
});

/* ------------------------------------------------------- ПОЛНЫЙ SEED */

export function seedState(): AppState {
  return {
    user: null,
    onboarded: false,
    channels: seedChannels(),
    posts: seedPosts(),
    competitors: seedCompetitors(),
    trends: seedTrends(),
    autopilot: seedAutopilot(),
    settings: seedSettings(),
    waitlist: [],
  };
}
