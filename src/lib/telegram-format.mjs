// Pure final-formatting rules shared by Composer preview, server preflight and worker.
import { normalizeRichTextEntities } from "./rich-text.mjs";
const PARAGRAPH_MAX = 300;
const SENTENCES_PER_PARAGRAPH = 3;
const SENTENCE_BREAK = /(?<=[.!?…])\s+(?=[А-ЯЁA-Z«„"])/;
const TAG_RE = /^#[\wа-яА-ЯёЁ]+(\s+#[\wа-яА-ЯёЁ]+)*$/;
const LIST_RE = /^\s*([—–-]|[•*]|[0-9]+[.)])\s+/;

function splitLongParagraph(block) {
  const sentences = block.split(SENTENCE_BREAK);
  if (sentences.length <= 1) return [block];
  if (sentences.length <= SENTENCES_PER_PARAGRAPH && block.length <= PARAGRAPH_MAX) return [block];
  const out = [];
  let current = "";
  let count = 0;
  for (const sentence of sentences) {
    if (
      current
      && (count >= SENTENCES_PER_PARAGRAPH || `${current} ${sentence}`.length > PARAGRAPH_MAX)
    ) {
      out.push(current);
      current = sentence;
      count = 1;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
      count += 1;
    }
  }
  if (current) out.push(current);
  return out;
}

export function formatPost(text) {
  if (!text) return text;
  let formatted = String(text).replace(/\r\n/g, "\n").trim();
  if (!formatted) return formatted;
  formatted = formatted.replace(/\n{3,}/g, "\n\n");
  formatted = formatted.replace(
    /^(.+?[.!?…»")])\s+(#[\wа-яА-ЯёЁ]+(?:[ \t]+#[\wа-яА-ЯёЁ]+)*)[ \t]*$/gm,
    "$1\n$2",
  );
  const paragraphs = [];
  let list = [];
  const flushList = () => {
    if (list.length) {
      paragraphs.push(list.join("\n"));
      list = [];
    }
  };
  for (const line of formatted.split("\n")) {
    const value = line.trim();
    if (!value) {
      flushList();
      continue;
    }
    if (TAG_RE.test(value)) {
      flushList();
      paragraphs.push(value);
      continue;
    }
    if (LIST_RE.test(value)) {
      list.push(value);
      continue;
    }
    flushList();
    paragraphs.push(...splitLongParagraph(value));
  }
  flushList();
  return paragraphs.join("\n\n").trim();
}

function escapeText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttribute(value) {
  return escapeText(value).replace(/"/g, "&quot;");
}

const STYLE_ORDER = Object.freeze({
  blockquote: 0,
  link: 1,
  bold: 2,
  italic: 3,
  underline: 4,
  strikethrough: 5,
  spoiler: 6,
  code: 7,
});

function entityStyle(entity) {
  switch (entity.type) {
    case "bold": return { key: "bold", open: "<b>", close: "</b>" };
    case "italic": return { key: "italic", open: "<i>", close: "</i>" };
    case "underline": return { key: "underline", open: "<u>", close: "</u>" };
    case "strikethrough": return { key: "strikethrough", open: "<s>", close: "</s>" };
    case "code": return { key: "code", open: "<code>", close: "</code>" };
    case "spoiler": return { key: "spoiler", open: "<tg-spoiler>", close: "</tg-spoiler>" };
    case "blockquote": return { key: "blockquote", open: "<blockquote>", close: "</blockquote>" };
    case "link": return {
      key: `link:${entity.url}`,
      open: `<a href="${escapeAttribute(entity.url)}">`,
      close: "</a>",
    };
    default: return null;
  }
}

function renderRichTextHtml(text, entities) {
  const source = String(text || "");
  const normalized = normalizeRichTextEntities(source, entities);
  let html = "";
  let active = [];
  let offset = 0;
  for (const character of source) {
    const end = offset + character.length;
    const next = normalized
      .filter((entity) => entity.offset <= offset && entity.offset + entity.length >= end)
      .sort((left, right) => STYLE_ORDER[left.type] - STYLE_ORDER[right.type])
      .map(entityStyle)
      .filter(Boolean);
    let common = 0;
    while (common < active.length && common < next.length && active[common].key === next[common].key) {
      common += 1;
    }
    for (let index = active.length - 1; index >= common; index -= 1) html += active[index].close;
    for (let index = common; index < next.length; index += 1) html += next[index].open;
    html += escapeText(character);
    active = next;
    offset = end;
  }
  for (let index = active.length - 1; index >= 0; index -= 1) html += active[index].close;
  return html;
}

export function toTelegramHtml(text, entities) {
  if (entities !== undefined) return renderRichTextHtml(text, entities);
  return escapeText(text)
    .replace(/\|\|([\s\S]+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>")
    .replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>");
}
