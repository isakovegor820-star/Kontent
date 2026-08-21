// Форма поста — работа кода, а не повод завернуть готовый текст.
//
// Проверка качества умела только вынести приговор: «в абзаце четыре предложения», «на два
// хэштега больше», «в текст попали служебные метки». Привести текст к правилам канала никто
// не пытался, и человек вместо поста получал счёт «62 из 85» с предложением выбрать другую
// модель — хотя ни одна модель не влияет на количество эмодзи.
//
// Здесь ни одно правило не меняет смысл: те же слова раскладываются по правилам профиля.
// Всё, что требует нового содержания (обращение на «вы», выдуманная конкретика, отсутствие
// источника), сюда не входит — это остаётся редактуре и человеку.

import { normalizePostQuality } from "./post-quality.mjs";
import { splitSentences } from "./ru-sentences.mjs";

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_GLOBAL = /\p{Extended_Pictographic}\uFE0F?/gu;
const HASHTAG_GLOBAL = /(?:^|\s)#[\p{L}\p{N}_]+/gu;
const PARAGRAPH_HAS_LIST = /^\s*(?:[-—•]|\d+[.)])\s/m;
const BULLET_PREFIX = /^\s*(?:[-—•]|\d+[.)])\s+/u;
const ENDS_COMPLETE = /[.!?…»”*)\]]$/u;
const META_LABELS = "хук|основная часть|основная|вывод|заключение|cta|призыв к действию";

const collapseBlankLines = (value) =>
  value
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/u, ""))
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();

const paragraphsOf = (value) =>
  String(value || "")
    .split(/\n\s*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

/**
 * Остаток промпта в начале строки убираем вместе с двоеточием. Внутри фразы «отсюда вывод:»
 * не трогаем: это обычная речь, а не разметка.
 */
function stripMetaLabels(value) {
  const label = new RegExp(`^\\s*(?:\\*\\*)?(?:${META_LABELS})(?:\\*\\*)?\\s*:\\s*`, "iu");
  return value
    .split("\n")
    .map((line) => line.replace(label, ""))
    .join("\n");
}

function normalizePunctuation(value) {
  return value
    .replace(/!{2,}/gu, "!")
    .replace(/\?{2,}/gu, "?")
    .replace(/(?:[!?]){3,}/gu, "?!")
    .replace(/\.{4,}/gu, "…")
    .replace(/…{2,}/gu, "…");
}

function limitHashtags(value, maxHashtags) {
  const matches = [...value.matchAll(HASHTAG_GLOBAL)];
  if (matches.length <= maxHashtags) return value;
  // Лишние снимаем с конца: последние хэштеги — служебный хвост, первые обычно в теле фразы.
  const doomed = matches.slice(maxHashtags);
  let result = value;
  for (const match of [...doomed].reverse()) {
    const leading = /^\s/u.test(match[0]) ? 1 : 0;
    result =
      result.slice(0, match.index + leading) + result.slice(match.index + match[0].length);
  }
  return result;
}

function limitEmoji(value, maxEmojis, allowedEmoji) {
  const matches = [...value.matchAll(EMOJI_GLOBAL)];
  if (matches.length <= maxEmojis) return value;
  const allowed = new Set([...String(allowedEmoji || "")].filter((char) => PICTOGRAPHIC.test(char)));
  const excess = matches.length - maxEmojis;
  const doomed = new Set();
  // Сначала то, чего нет в наборе канала, затем лишнее с конца.
  for (let i = matches.length - 1; i >= 0 && doomed.size < excess; i -= 1) {
    if (!allowed.has([...matches[i][0]][0])) doomed.add(i);
  }
  for (let i = matches.length - 1; i >= 0 && doomed.size < excess; i -= 1) doomed.add(i);
  let result = value;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (!doomed.has(i)) continue;
    result = result.slice(0, matches[i].index) + result.slice(matches[i].index + matches[i][0].length);
  }
  return result;
}

/** Списки запрещены профилем: снимаем маркеры, оставляя пункты обычными предложениями. */
function unbulletLists(value) {
  return paragraphsOf(value)
    .map((paragraph) => {
      if (!PARAGRAPH_HAS_LIST.test(paragraph)) return paragraph;
      return paragraph
        .split("\n")
        .map((line) => {
          const plain = line.replace(BULLET_PREFIX, "").trim();
          if (!plain) return "";
          const capitalized = plain.charAt(0).toLocaleUpperCase("ru") + plain.slice(1);
          return ENDS_COMPLETE.test(capitalized) ? capitalized : `${capitalized}.`;
        })
        .filter(Boolean)
        .join(" ");
    })
    .join("\n\n");
}

/** Оборванный хвост убираем, а не заклеиваем точкой: выдуманный конец хуже короткого текста. */
function dropTruncatedTail(value, minChars) {
  const trimmed = value.trim();
  if (!trimmed || ENDS_COMPLETE.test(trimmed)) return trimmed;
  const sentences = splitSentences(trimmed);
  if (sentences.length < 2) return trimmed;
  const kept = sentences.slice(0, -1).join(" ").trim();
  return ENDS_COMPLETE.test(kept) && kept.length >= minChars ? kept : trimmed;
}

// Границы, по которым длинное предложение делится на два без потери смысла. Только
// сочинительные союзы, тире и двоеточие: после «если» или «когда» остаётся обрубок.
const CLAUSE_BREAKS = [", и ", ", но ", ", а ", ", однако ", ", зато ", "; ", " — ", ": "];

/**
 * Одно длинное предложение → два. Союз остаётся во второй фразе: «и это стоит признать»
 * превращается в «И это стоит признать», а не теряется вместе с связкой.
 * Возвращает null, если аккуратной границы нет.
 */
function splitLongSentence(sentence, maxChars) {
  let best = null;
  for (const separator of CLAUSE_BREAKS) {
    const keepsConjunction = separator.startsWith(", ");
    let at = sentence.indexOf(separator);
    while (at > 0) {
      const head = sentence.slice(0, at).trim();
      if (head.length <= maxChars && head.length >= 25 && (!best || head.length > best[0].length)) {
        const tail = sentence.slice(at + (keepsConjunction ? 2 : separator.length)).trim();
        if (tail) best = [`${head}.`, tail.charAt(0).toLocaleUpperCase("ru") + tail.slice(1)];
      }
      at = sentence.indexOf(separator, at + 1);
    }
  }
  return best;
}

/** Хук живёт на своей строке: длинная первая строка — это склеенный абзац, а не плохой хук. */
function detachHook(value, hookMaxChars) {
  const paragraphs = paragraphsOf(value);
  const first = paragraphs[0];
  if (!first) return value;
  const firstLine = first.split("\n")[0].trim();
  if (firstLine.length <= hookMaxChars) return value;
  const sentences = splitSentences(first);
  if (sentences[0] && sentences[0].length > hookMaxChars) {
    const split = splitLongSentence(sentences[0], hookMaxChars);
    if (!split) return value;
    sentences.splice(0, 1, ...split);
  }
  if (sentences.length < 2) return value;
  return [sentences[0], sentences.slice(1).join(" "), ...paragraphs.slice(1)]
    .filter(Boolean)
    .join("\n\n");
}

function splitDenseParagraphs(value, maxSentences) {
  return paragraphsOf(value)
    .flatMap((paragraph) => {
      if (PARAGRAPH_HAS_LIST.test(paragraph)) return [paragraph];
      const sentences = splitSentences(paragraph);
      if (sentences.length <= maxSentences) return [paragraph];
      // Делим на равные части, чтобы в хвосте не оставалось одинокое предложение.
      const parts = Math.ceil(sentences.length / maxSentences);
      const perPart = Math.ceil(sentences.length / parts);
      const chunks = [];
      for (let i = 0; i < sentences.length; i += perPart) {
        chunks.push(sentences.slice(i, i + perPart).join(" "));
      }
      return chunks;
    })
    .join("\n\n");
}

/** Профиль требует хук, тело и вывод: три абзаца получаются делением, а не дописыванием. */
function ensureThreeParagraphs(value, maxSentences) {
  let paragraphs = paragraphsOf(value);
  while (paragraphs.length < 3) {
    const index = paragraphs.reduce(
      (longest, paragraph, i) =>
        splitSentences(paragraph).length > splitSentences(paragraphs[longest]).length ? i : longest,
      0,
    );
    const sentences = splitSentences(paragraphs[index]);
    if (sentences.length < 2 || PARAGRAPH_HAS_LIST.test(paragraphs[index])) break;
    const head = Math.min(maxSentences, Math.ceil(sentences.length / 2));
    paragraphs = [
      ...paragraphs.slice(0, index),
      sentences.slice(0, head).join(" "),
      sentences.slice(head).join(" "),
      ...paragraphs.slice(index + 1),
    ];
  }
  return paragraphs.join("\n\n");
}

/**
 * Форма поста по правилам профиля. Длину, дисклеймер и жирное выделение сюда не включаем:
 * они меняют размер текста, и порядок с подгонкой объёма важен — см. finishPostForm.
 */
export function normalizePostForm(text, rawQuality) {
  const q = normalizePostQuality(rawQuality);
  let value = collapseBlankLines(String(text || ""));
  if (!value) return "";
  value = stripMetaLabels(value);
  value = normalizePunctuation(value);
  value = limitHashtags(value, q.maxHashtags);
  value = limitEmoji(value, q.maxEmojis, q.allowedEmoji);
  if (q.boldPolicy === "none") value = value.replace(/\*\*([^*]+)\*\*/gu, "$1");
  if (q.listPolicy === "avoid") value = unbulletLists(value);
  value = collapseBlankLines(value);
  value = dropTruncatedTail(value, q.minChars);
  if (q.hookRequired) value = detachHook(value, q.hookMaxChars);
  value = splitDenseParagraphs(value, q.maxParagraphSentences);
  if (q.requireConclusion) value = ensureThreeParagraphs(value, q.maxParagraphSentences);
  return collapseBlankLines(value);
}

/** Сколько знаков надо оставить свободными под обязательный дисклеймер. */
export function reservedFormChars(text, rawQuality) {
  const q = normalizePostQuality(rawQuality);
  if (!q.disclaimerRequired || !q.disclaimerText) return 0;
  return String(text || "").includes(q.disclaimerText) ? 0 : q.disclaimerText.length + 2;
}

/**
 * Последний шаг после подгонки объёма: дисклеймер дословно и одно жирное выделение, если
 * профиль их требует. Раньше и то и другое было замечанием проверки, хотя добавить их —
 * механическая работа, которую модель может забыть, а код забыть не может.
 */
export function finishPostForm(text, rawQuality) {
  const q = normalizePostQuality(rawQuality);
  let value = collapseBlankLines(String(text || ""));
  if (!value) return "";
  if (q.disclaimerRequired && q.disclaimerText && !value.includes(q.disclaimerText)) {
    value = `${value}\n\n${q.disclaimerText}`;
  }
  if (q.boldPolicy === "required" && !/\*\*[^*]+\*\*/u.test(value)) {
    const paragraphs = paragraphsOf(value);
    // Выделяем первую фразу вывода: это оформление, а не новая мысль.
    const target = q.disclaimerRequired && q.disclaimerText ? paragraphs.length - 2 : paragraphs.length - 1;
    const sentences = splitSentences(paragraphs[target] || "");
    if (sentences[0] && sentences[0].length <= 140 && value.length + 4 <= q.maxChars) {
      paragraphs[target] = [`**${sentences[0]}**`, ...sentences.slice(1)].join(" ");
      value = paragraphs.join("\n\n");
    }
  }
  return collapseBlankLines(value);
}
