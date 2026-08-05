// Чистое ядро воркера: функции без сайд-эффектов (не трогают pool/Redis/TOKEN/fetch).
// Вынесены из worker.mjs, чтобы их можно было импортировать и тестировать изолированно —
// сам worker.mjs при импорте поднимает пул, Redis и BullMQ, что для тестов неприемлемо.
// Тела функций НЕ менялись при переносе — только добавлен export.

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

// ── Разметка и клавиатура Telegram ───────────────────────────────────────────
// Наша разметка → HTML Telegram: ||спойлер|| и **жирный**. Спецсимволы экранируем.
export function toTelegramHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|\|([\s\S]+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>")
    .replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>");
}

// ── Гарант структуры поста ───────────────────────────────────────────────────
// Промпт просит ИИ разбивать текст на абзацы, но модель может «забыть». Форматтер
// дожимает программно: режет «простыни» по границам предложений (абзац — не длиннее
// PARAGRAPH_MAX знаков и не больше SENTENCES_PER_PARAGRAPH предложений), отрывает
// хэштеги в отдельные блоки, списки сохраняет столбиком. Консервативен: слова не
// меняет, только добавляет переносы. Применяется перед самой публикацией.
const PARAGRAPH_MAX = 300; // знаков без переноса — дальше «простыня», режем
const SENTENCES_PER_PARAGRAPH = 3; // предложений в абзаце — как в промпте («1–3»)

/** Граница предложения: точка/!/…/… + пробел + заглавная буква или кавычка. */
const SENTENCE_BREAK = /(?<=[.!?…])\s+(?=[А-ЯЁA-Z«„"])/;
const TAG_RE = /^#[\wа-яА-ЯёЁ]+(\s+#[\wа-яА-ЯёЁ]+)*$/;
const LIST_RE = /^\s*([—–-]|[•*]|[0-9]+[.)])\s+/;

/** Режет одну длинную строку на абзацы по границам предложений.
 * Абзац «хороший», если он короткий И в нём не больше SENTENCES_PER_PARAGRAPH
 * предложений — иначе режем, даже если по знакам лимит не превышен. */
function splitLongParagraph(block) {
  const sentences = block.split(SENTENCE_BREAK);
  if (sentences.length <= 1) return [block]; // одно предложение — некуда резать
  if (sentences.length <= SENTENCES_PER_PARAGRAPH && block.length <= PARAGRAPH_MAX) return [block];

  const out = [];
  let cur = "";
  let count = 0;
  for (const s of sentences) {
    if (cur && (count >= SENTENCES_PER_PARAGRAPH || (cur + " " + s).length > PARAGRAPH_MAX)) {
      out.push(cur);
      cur = s;
      count = 1;
    } else {
      cur = cur ? cur + " " + s : s;
      count++;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Доводит текст поста до читаемой структуры: воздух между абзацами, без «простыней».
 * Гарантии:
 *  — абзац не длиннее PARAGRAPH_MAX и не больше SENTENCES_PER_PARAGRAPH предложений;
 *  — хэштеги — всегда отдельным блоком (включая «прилипшие» к концу предложения);
 *  — списки («— пункт» / «• пункт») остаются столбиком, не склеиваются с текстом;
 *  — не более одной пустой строки между блоками.
 */
export function formatPost(text) {
  if (!text) return text;
  let t = String(text).replace(/\r\n/g, "\n").trim();
  if (!t) return t;

  // 1. Схлопываем 3+ переноса до одной пустой строки.
  t = t.replace(/\n{3,}/g, "\n\n");

  // 2. Хэштеги, «прилипшие» к концу предложения, отрываем на отдельную строку.
  t = t.replace(/^(.+?[.!?…»")])\s+(#[\wа-яА-ЯёЁ]+(?:[ \t]+#[\wа-яА-ЯёЁ]+)*)[ \t]*$/gm, "$1\n$2");

  // 3. Собираем итоговые абзацы. Каждая длинная строка режется по предложениям,
  //    соседние строки-списки группируются в один блок, теги — в свой блок.
  const paragraphs = [];
  let listBuf = [];
  const flushList = () => {
    if (listBuf.length) {
      paragraphs.push(listBuf.join("\n"));
      listBuf = [];
    }
  };

  for (const line of t.split("\n")) {
    const s = line.trim();
    if (!s) {
      flushList(); // пустая строка — граница блока
      continue;
    }
    if (TAG_RE.test(s)) {
      flushList();
      paragraphs.push(s);
      continue;
    }
    if (LIST_RE.test(s)) {
      listBuf.push(s);
      continue;
    }
    flushList();
    paragraphs.push(...splitLongParagraph(s));
  }
  flushList();

  return paragraphs.join("\n\n").trim();
}

/** buttons — массив рядов: [[{ text, data }|{ text, url }]]. */
export function keyboard(buttons) {
  if (!buttons?.length) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })),
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
// или хотя бы один пост остался заглушкой. В таком случае BullMQ повторит всю сборку, а
// предыдущий готовый план останется в базе до полноценного результата.
export function autopilotBuildComplete(expected, topics, items = null) {
  const count = Number(expected);
  if (!Number.isInteger(count) || count < 1) return false;
  if (!Array.isArray(topics) || topics.length !== count) return false;
  if (items == null) return true;
  return Array.isArray(items) &&
    items.length === count &&
    items.every((item) => item?.aiReady === true && String(item?.draft || "").trim().length > 0);
}

export function autopilotJobAttemptsExhausted(attemptsMade, configuredAttempts) {
  const made = Math.max(0, Number(attemptsMade) || 0);
  const allowed = Math.max(1, Number(configuredAttempts) || 1);
  return made >= allowed;
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
/**
 * Раскладка N постов по НЕДЕЛЕ (7 дней), а не по N дням.
 * Раньше пост i вставал на день i+1: пять постов — пять дней, семь — семь. Поэтому и стоял
 * потолок 7 — он прятал то, что при 14 план разъезжался на две недели вместо «14 за неделю».
 * Теперь: дни делим поровну, а внутри дня разносим по часам, чтобы посты не падали в одну минуту.
 * Возвращает массив ISO-строк длиной N.
 */
export function weekSlots(n, bestHour) {
  const perDay = Math.ceil(n / 7);
  const out = [];
  for (let i = 0; i < n; i++) {
    const day = Math.floor(i / perDay) + 1;
    const slot = i % perDay;
    let hour;
    if (perDay === 1) {
      hour = bestHour; // один пост в день — ставим в лучший час по аналитике
    } else {
      // Несколько постов в день — разносим равномерно по дневному окну 9:00–21:00.
      // Впритык друг к другу их ставить нельзя: подписчик получит пачку уведомлений.
      const from = 9;
      const to = 21;
      hour = Math.round(from + (slot * (to - from)) / (perDay - 1));
    }
    out.push(`${mskDatePlus(day)}T${String(hour).padStart(2, "0")}:00:00+03:00`);
  }
  return out;
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
