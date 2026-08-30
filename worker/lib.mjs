// Чистое ядро воркера: функции без сайд-эффектов (не трогают pool/Redis/TOKEN/fetch).
// Вынесены из worker.mjs, чтобы их можно было импортировать и тестировать изолированно —
// сам worker.mjs при импорте поднимает пул, Redis и BullMQ, что для тестов неприемлемо.
// Тела функций НЕ менялись при переносе — только добавлен export.

import {
  isAutopilotHumanReviewItem,
  isAutopilotReaderReadyItem,
} from "../src/lib/autopilot-review.mjs";

// ── Нарезка текста на куски для базы знаний (RAG) ───────────────────────────
// Куски базы знаний — это НЕ «нарезка стены текста по N знаков». Материал юриста сам
// состоит из готовых единиц: один кейс, один вопрос с ответом, одна услуга, один факт.
// Пустая строка между ними — авторская граница мысли, и она надёжнее любой эвристики.
//
// Абзацы НЕ склеиваем, даже если влезают в один кусок. Замерено на трёх фактах в одном
// источнике (срок процедуры / единственное жильё / МФЦ): склеенный кусок даёт вектор-смесь
// трёх тем, и запрос «заберут ли единственную квартиру?» набрал по нему 0.426 — НИЖЕ порога
// опоры. То есть факт в базе есть, а система ответила бы «не пишу». По абзацам — 0.519,
// проходит. Один кусок = одна мысль.
const CHUNK_MAX = 900; // знаков; выше — в куске неизбежно несколько тем, вектор мутнеет
const CHUNK_MIN = 80; // ниже — обрывок без смысла, липнет к предыдущему куску

export function splitChunks(raw) {
  const text = String(raw || "").replace(/\r/g, "").trim();
  if (!text) return [];
  const paras = text
    .split(/\n\s*\n+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const out = [];
  const push = (t) => {
    const v = t.trim();
    if (!v) return;
    // Короткий хвост сам по себе бесполезен («Исключение:» без продолжения), но и терять
    // его нельзя — приклеиваем к предыдущему куску.
    if (v.length < CHUNK_MIN && out.length) out[out.length - 1] += "\n\n" + v;
    else out.push(v);
  };

  for (const para of paras) {
    if (para.length <= CHUNK_MAX) {
      push(para);
      continue;
    }
    // Абзац длиннее предела — режем по концам предложений, а не по счётчику знаков:
    // обрыв на середине фразы даёт кусок, по которому нельзя написать пост.
    let cur = "";
    for (const sent of para.split(/(?<=[.!?…])\s+/)) {
      if (cur && (cur + " " + sent).length > CHUNK_MAX) {
        push(cur);
        cur = sent;
      } else cur += (cur ? " " : "") + sent;
    }
    push(cur);
  }
  return out;
}

// ── Разметка и финальный формат Telegram ────────────────────────────────────
// Единая реализация также используется Composer preview и server-side preflight.
export { formatPost, toTelegramHtml } from "../src/lib/telegram-format.mjs";

/** buttons — массив рядов: callback, URL или Telegram Mini App. */
export function keyboard(buttons) {
  if (!buttons?.length) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((b) => b.webApp
        ? { text: b.text, web_app: { url: b.webApp } }
        : b.url
          ? { text: b.text, url: b.url }
          : { text: b.text, callback_data: b.data }),
    ),
  };
}

// ── Ограниченный параллелизм ─────────────────────────────────────────────────
// Пул из `limit` «дорожек», каждая тянет следующий элемент, пока они не кончатся.
// Порядок результатов сохраняется (по индексу). Переносит последовательные
// for...of-циклы сбора на N параллельных запросов — окно сбора сжимается.
export async function mapConcurrent(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function lane() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return out;
}

// План нельзя объявлять готовым, если модель вернула меньше тем, чем попросил человек,
// хотя бы один пост остался заглушкой ИЛИ не прошёл редакционный порог. Аврора не должна
// перекладывать проверку собственного слабого черновика на пользователя: BullMQ повторит
// сборку, а предыдущий хороший план останется в базе до полноценного результата.
export function autopilotBuildComplete(expected, topics, items = null) {
  const count = Number(expected);
  if (!Number.isInteger(count) || count < 1) return false;
  if (!Array.isArray(topics) || topics.length !== count) return false;
  if (items == null) return true;
  return Array.isArray(items) &&
    items.length === count &&
    items.every((item) =>
      item?.aiReady === true &&
      String(item?.draft || "").trim().length > 0 &&
      item?.qualityBlocked !== true &&
      item?.quality?.passed === true,
    );
}

// Confirm-план может содержать как полностью готовые тексты, так и безопасные черновики,
// которым нужно явное решение человека. Внутренний идеальный критерий выше остаётся строже.
export function autopilotDraftsDeliverable(expected, topics, items = null) {
  const count = Number(expected);
  if (!Number.isInteger(count) || count < 1) return false;
  if (!Array.isArray(topics) || topics.length !== count) return false;
  return Array.isArray(items) &&
    items.length === count &&
    items.every((item) =>
      item?.aiReady === true &&
      String(item?.draft || "").trim().length > 0 &&
      (
        isAutopilotReaderReadyItem(item) ||
        isAutopilotHumanReviewItem(item)
      ),
    );
}

export function autopilotJobAttemptsExhausted(attemptsMade, configuredAttempts) {
  const made = Math.max(0, Number(attemptsMade) || 0);
  const allowed = Math.max(1, Number(configuredAttempts) || 1);
  return made >= allowed;
}

export function autopilotJobTerminalFailure(attemptsMade, configuredAttempts, reason = "") {
  // BullMQ does not increment attemptsMade when a job is failed by maxStalledCount, even
  // though that state is terminal. Without this branch the DB placeholder stays `building`.
  return autopilotJobAttemptsExhausted(attemptsMade, configuredAttempts)
    || /stalled more than allowable limit/iu.test(String(reason));
}

export function boundedAutopilotRewriteAttempts(value) {
  const attempts = Number(value);
  return Number.isFinite(attempts)
    ? Math.min(3, Math.max(0, Math.round(attempts)))
    : 1;
}

// ── Разбор публичной страницы t.me/s/ ────────────────────────────────────────
// "1.2K"/"50" → число
export function parseCount(s) {
  const t = String(s).trim().replace(/\s/g, "").replace(",", ".");
  const m = t.match(/^([\d.]+)([KMkm]?)$/);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (/k/i.test(m[2])) n *= 1000;
  if (/m/i.test(m[2])) n *= 1e6;
  return Math.round(n);
}

// Сумма реакций поста из блока его разметки. Число стоит ПОСЛЕ вложенного эмодзи:
//   <span class="tgme_reaction"><tg-emoji …></tg-emoji>30.7K</span>
// Поэтому берём span целиком, срезаем теги и читаем хвост. Старый вариант ловил текст сразу
// после `tgme_reaction">` и упирался в первый же `<`, то есть всегда возвращал 0 (ревью).
// null — реакции на канале выключены; 0 — реакции есть, но никто не поставил.
export function sumReactions(block) {
  const spans = [...block.matchAll(/<span class="tgme_reaction[^"]*">([\s\S]*?)<\/span>/g)];
  if (!spans.length) return null;
  let sum = 0;
  for (const s of spans) {
    const plain = s[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const num = (plain.match(/([\d.,]+[KM]?)\s*$/i) || [])[1];
    if (num) sum += parseCount(num) || 0;
  }
  return sum;
}

export function plural(n, one, few, many) {
  const m10 = n % 10,
    m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n));
      } catch {
        return "";
      }
    });
}

/**
 * Публичное описание канала из шапки t.me/s/. Telegram оставляет внутри ссылки и
 * переносы строк, поэтому возвращаем чистый читаемый текст, а не HTML из внешнего
 * источника. null отличает отсутствующее описание от пустой строки после очистки.
 */
export function parseTelegramChannelDescription(html) {
  const match = String(html).match(
    /<div\b[^>]*class=["'][^"']*\btgme_channel_info_description\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/iu,
  );
  if (!match) return null;

  const text = decodeEntities(
    match[1]
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<[^>]+>/gu, "")
      .replace(/[ \t\f\v]+/gu, " ")
      .replace(/ *\n */gu, "\n")
      .replace(/\n{2,}/gu, "\n"),
  ).trim();

  return text || null;
}

/**
 * Из последних публичных постов считает недавний темп без догадок о «качестве» канала.
 * Темп — средний интервал между видимыми постами, а не число постов на странице: Telegram
 * ограничивает публичную выдачу, поэтому простой count занижал бы активные каналы.
 */
export function summarizeTelegramPostingActivity(posts) {
  const timestamps = (Array.isArray(posts) ? posts : [])
    .map((post) => Date.parse(String(post?.postedAt || "")))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);

  if (timestamps.length === 0) return { lastPostAt: null, postsPerWeek: null };

  const lastPostAt = new Date(timestamps[0]).toISOString();
  if (timestamps.length < 2) return { lastPostAt, postsPerWeek: null };

  const spanDays = Math.max((timestamps[0] - timestamps[timestamps.length - 1]) / 86_400_000, 1);
  const rawRate = ((timestamps.length - 1) * 7) / spanDays;
  const postsPerWeek = Math.round(Math.min(rawRate, 99) * 10) / 10;

  return { lastPostAt, postsPerWeek };
}

// ── Страж фактов ─────────────────────────────────────────────────────────────
/**
 * СТРАЖ ФАКТОВ. Ищет в готовом посте конкретику, которой нет в опоре: числа, даты,
 * номера статей и дел, суммы.
 *
 * Почему это обязательная часть, а не перестраховка: проверка коммерческих юридических
 * RAG-систем дала 17–33% выдумок ДАЖЕ на закрытой выверенной базе (против ~43% у голой
 * модели). То есть база снижает враньё в разы, но не убирает его. А модели класса
 * Hermes 3 8B выдумывают даже когда фактов в контексте достаточно.
 *
 * Поэтому проверяем результат кодом, а не доверием к модели: спрашивать саму модель
 * «ты ничего не выдумал?» бессмысленно — воздержание не является свойством модели,
 * это доказано отдельно.
 *
 * Возвращает список выдумок (пустой — пост чист).
 */
export function findInvented(draft, support) {
  const text = String(draft || "");
  if (!text.trim()) return [];
  const facts = support.map((c) => c.text).join(" ");

  // Всё, на что пост ИМЕЕТ право ссылаться: числа из фактов + числа словами.
  const allowed = new Set((facts.match(/\d+/g) || []));
  // Сумма «2 300 000» в факте раньше раскалывалась на 2/300/000, а в посте проверялась
  // как 2300000 и объявлялась выдумкой. Храним и нормализованный вариант группы цифр.
  for (const m of facts.match(/\d[\d\s ]{2,}/g) || []) allowed.add(m.replace(/[\s ]/g, ""));
  const WORD_NUM = /(шесть|шести|семь|семи|восемь|восьми|пять|пяти|три|тр[её]х|десять|сто|тысяч\S*|миллион\S*|полгода)/gi;
  // Падеж не меняет число: факт «шесть месяцев» разрешает тексту сказать «в течение
  // шести месяцев». Сравнение исходных слов объявляло такую грамматику выдумкой.
  const numberWordKey = (word) => {
    const w = word.toLowerCase();
    if (/^шест/.test(w)) return "6";
    if (/^сем/.test(w)) return "7";
    if (/^(?:восем|восьм)/.test(w)) return "8";
    if (/^пят/.test(w)) return "5";
    if (/^(?:три|тр[её]х)/.test(w)) return "3";
    if (/^десят/.test(w)) return "10";
    if (/^полгода/.test(w)) return "half-year";
    return w;
  };
  const allowedWords = new Set((facts.toLowerCase().match(WORD_NUM) || []).map(numberWordKey));

  const bad = [];
  const add = (what) => {
    if (!bad.includes(what)) bad.push(what);
  };

  // 1. Числа. Однозначные пропускаем: «2 абзаца», «на 100%» — это не реквизиты.
  for (const m of text.match(/\d[\d\s  ]{2,}/g) || []) {
    const n = m.replace(/[\s  ]/g, "");
    if (n.length >= 3 && !allowed.has(n)) add(`число ${m.trim()}`);
  }
  // 2. Номера статей и законов — самое опасное для юриста.
  for (const m of text.match(/стать[ьияюей]+\s*№?\s*\d+|ст\.\s*\d+|ФЗ[-\s]?№?\s?\d+|п\.\s?\d+\s?ст/gi) || []) {
    const n = m.match(/\d+/)?.[0];
    if (n && !allowed.has(n)) add(`статья «${m.trim()}»`);
  }
  // 3. Номера дел.
  for (const m of text.match(/№\s*[\wА-Яа-я\-\/]{2,}|дел[оау]\s+№\s*\S+|А\d{2}[-–]\d+/gi) || []) {
    add(`номер дела «${m.trim()}»`);
  }
  // 4. Даты — «решение от 10 июля 2026 года» ровно этим и было.
  const DATE =
    /\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\S*(?:\s+\d{4})?|(?:19|20)\d{2}\s*год\S*/gi;
  for (const m of text.match(DATE) || []) {
    if (!facts.toLowerCase().includes(m.toLowerCase().trim())) add(`дата «${m.trim()}»`);
  }
  // 5. Сроки словами: «три месяца» вместо «шести» — подмена факта, а не выдумка с нуля,
  //    но для читателя это одинаково неверно.
  for (const m of text.match(/(шесть|шести|семь|семи|восемь|восьми|пять|пяти|три|тр[её]х|десять|полгода)\s*(?:месяц\S*|год\S*|лет|недел\S*)/gi) || []) {
    const w = numberWordKey(m.split(/\s+/)[0]);
    if (!allowedWords.has(w)) add(`срок «${m.trim()}»`);
  }
  return bad;
}

// Ссылки [1] нужны нам, а не читателю: в готовом посте их быть не должно.
export const stripCites = (t) => String(t || "").replace(/\s*\[\d+\]/g, "").replace(/[ \t]{2,}/g, " ").trim();

/**
 * Доля утверждений с опорой: сколько предложений помечены ссылкой на факт.
 * Мера грубая, но честная и проверяемая — ловит ровно то, что нужно: пост, где модель
 * ушла от фактов в свободный пересказ. Короткие фразы («Да.», заголовок) не считаем.
 */
export function citedShare(text) {
  const sents = String(text || "")
    .split(/(?<=[.!?…])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 25);
  if (!sents.length) return 0;
  return sents.filter((x) => /\[\d+\]/.test(x)).length / sents.length;
}

// ── Раскладка постов по неделе ───────────────────────────────────────────────
function variedSinglePostHours(bestHour) {
  const preferred = Math.max(9, Math.min(21, Math.round(Number(bestHour) || 19)));
  const hours = [preferred];
  for (let distance = 1; hours.length < 7 && distance <= 12; distance++) {
    const earlier = preferred - distance;
    const later = preferred + distance;
    if (earlier >= 9) hours.push(earlier);
    if (hours.length < 7 && later <= 21) hours.push(later);
  }
  return hours;
}

/**
 * Раскладка N постов по НЕДЕЛЕ (7 дней), а не по N дням.
 * Раньше пост i вставал на день i+1: пять постов — пять дней, семь — семь. Поэтому и стоял
 * потолок 7 — он прятал то, что при 14 план разъезжался на две недели вместо «14 за неделю».
 * Теперь: дни делим поровну, а внутри дня разносим по часам, чтобы посты не падали в одну минуту.
 * Возвращает массив ISO-строк длиной N.
 */
export function periodSlots(n, weeks, bestHour) {
  const count = Math.max(0, Math.round(Number(n) || 0));
  const days = Math.max(7, Math.round(Number(weeks) || 1) * 7);
  const byDay = new Map();
  const singlePostHours = variedSinglePostHours(bestHour);
  for (let i = 0; i < count; i++) {
    // Evenly span the complete horizon. The old `i / perDay` layout put a capped
    // 90-post plan into the first half of its 12-week period and left the rest empty.
    const day = Math.floor((i * days) / count) + 1;
    const group = byDay.get(day) || [];
    group.push(i);
    byDay.set(day, group);
  }

  const out = [];
  for (const [day, indices] of byDay) {
    const perDay = indices.length;
    for (let slot = 0; slot < perDay; slot++) {
      let hour;
      if (perDay === 1) {
        // Лучший час остаётся первым приоритетом, остальные дни получают соседние окна.
        // Так недельный план не выглядит как семь одинаковых таймеров и одновременно
        // остаётся рядом с реальным пиком аудитории.
        hour = singlePostHours[(day - 1) % singlePostHours.length];
      } else {
        // Несколько постов в день — разносим равномерно по дневному окну 9:00–21:00.
        // Впритык друг к другу их ставить нельзя: подписчик получит пачку уведомлений.
        const from = 9;
        const to = 21;
        hour = Math.round(from + (slot * (to - from)) / (perDay - 1));
      }
      out.push(`${mskDatePlus(day)}T${String(hour).padStart(2, "0")}:00:00+03:00`);
    }
  }
  return out;
}

export function weekSlots(n, bestHour) {
  return periodSlots(n, 1, bestHour);
}

// МСК-дата через K дней в формате YYYY-MM-DD.
export function mskDatePlus(days) {
  return new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-CA", {
    timeZone: "Europe/Moscow",
  });
}

// ── Парсинг RSS/Atom без зависимостей ────────────────────────────────────────
// Простой regex-парсер: достаёт title, link, description/summary, guid, pubDate
// из RSS 2.0 и Atom. Не претендует на полноту — достаточно для новостных лент.

/** Убирает CDATA и HTML-теги из текста. */
function stripXml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** Достаёт содержимое тега (первое вхождение). */
function tagContent(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = xml.match(re);
  return m ? stripXml(m[1]) : "";
}

function rssDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Парсит XML RSS 2.0 или Atom. Возвращает массив элементов:
 * [{ guid, title, link, summary, publishedAt }]
 */
export function parseRss(xml) {
  const items = [];
  // Определяем формат: Atom использует <entry>, RSS использует <item>
  const isAtom = /<feed[\s>]/i.test(xml);
  const itemTag = isAtom ? "entry" : "item";
  const itemRe = new RegExp(`<${itemTag}[\\s>]([\\s\\S]*?)<\\/${itemTag}>`, "gi");

  let match;
  while ((match = itemRe.exec(xml)) !== null) {
    const block = match[1];

    let title, link, summary, guid, pubDate;

    if (isAtom) {
      title = tagContent(block, "title");
      // Atom link: <link href="..."/> или <link>...</link>
      const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = linkMatch ? linkMatch[1] : tagContent(block, "link");
      summary = tagContent(block, "summary") || tagContent(block, "content");
      guid = tagContent(block, "id") || link || title;
      pubDate = tagContent(block, "published") || tagContent(block, "updated");
    } else {
      title = tagContent(block, "title");
      link = tagContent(block, "link");
      summary = tagContent(block, "description") || tagContent(block, "content:encoded");
      guid = tagContent(block, "guid") || link || title;
      pubDate = tagContent(block, "pubDate") || tagContent(block, "dc:date");
    }

    if (!title && !summary) continue; // пустой элемент — пропускаем

    items.push({
      guid: guid || `${title}-${link}`,
      title: title.slice(0, 300),
      link: link.slice(0, 500),
      summary: summary.slice(0, 2000),
      publishedAt: rssDate(pubDate),
    });
  }

  return items;
}
