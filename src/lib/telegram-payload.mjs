import { formatPost, toTelegramHtml } from "./telegram-format.mjs";

export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;

const ENTITY_TEXT = Object.freeze({ "&amp;": "&", "&lt;": "<", "&gt;": ">" });
const TOKEN_RE = /<a href="[^"]*">|<\/a>|<b>|<\/b>|<i>|<\/i>|<u>|<\/u>|<s>|<\/s>|<code>|<\/code>|<blockquote>|<\/blockquote>|<tg-spoiler>|<\/tg-spoiler>|&amp;|&lt;|&gt;|[\s\S]/gu;

function openingStyle(token) {
  if (token === "<b>") return { type: "bold", key: "bold", open: token, close: "</b>" };
  if (token === "<i>") return { type: "italic", key: "italic", open: token, close: "</i>" };
  if (token === "<u>") return { type: "underline", key: "underline", open: token, close: "</u>" };
  if (token === "<s>") return { type: "strikethrough", key: "strikethrough", open: token, close: "</s>" };
  if (token === "<code>") return { type: "code", key: "code", open: token, close: "</code>" };
  if (token === "<blockquote>") return { type: "blockquote", key: "blockquote", open: token, close: "</blockquote>" };
  if (token === "<tg-spoiler>") return { type: "spoiler", key: "spoiler", open: token, close: "</tg-spoiler>" };
  if (token.startsWith("<a href=")) return { type: "link", key: token, open: token, close: "</a>" };
  return null;
}

function closingType(token) {
  return ({
    "</b>": "bold",
    "</i>": "italic",
    "</u>": "underline",
    "</s>": "strikethrough",
    "</code>": "code",
    "</blockquote>": "blockquote",
    "</tg-spoiler>": "spoiler",
    "</a>": "link",
  })[token] || null;
}

/**
 * Telegram documents message limits after entity parsing. Each atom keeps the exact HTML
 * fragment and its visible UTF-16 length (the same unit Telegram entity offsets use), so
 * tags and escaped entities never inflate or under-count a payload boundary.
 */
export function parseTelegramHtml(html) {
  const active = [];
  const atoms = [];
  for (const match of String(html || "").matchAll(TOKEN_RE)) {
    const token = match[0];
    const style = openingStyle(token);
    if (style) {
      active.push(style);
      continue;
    }
    const closing = closingType(token);
    if (closing) {
      const index = active.findLastIndex((candidate) => candidate.type === closing);
      if (index >= 0) active.splice(index, 1);
      continue;
    }
    const text = ENTITY_TEXT[token] || token;
    atoms.push({ html: token, text, length: text.length, styles: [...active] });
  }
  return atoms;
}

export function telegramEntityLength(html) {
  return parseTelegramHtml(html).reduce((total, atom) => total + atom.length, 0);
}

function commonPrefixLength(left, right) {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function renderAtoms(atoms) {
  let html = "";
  let active = [];
  for (const atom of atoms) {
    const activeKeys = active.map((style) => style.key);
    const nextKeys = atom.styles.map((style) => style.key);
    const common = commonPrefixLength(activeKeys, nextKeys);
    for (let index = active.length - 1; index >= common; index -= 1) html += active[index].close;
    for (let index = common; index < atom.styles.length; index += 1) html += atom.styles[index].open;
    active = [...atom.styles];
    html += atom.html;
  }
  for (let index = active.length - 1; index >= 0; index -= 1) html += active[index].close;
  return html;
}

function boundaryScore(atoms, end) {
  const previous = atoms[end - 1]?.text || "";
  const beforePrevious = atoms[end - 2]?.text || "";
  const next = atoms[end]?.text || "";
  if (previous === "\n" && beforePrevious === "\n") return 5;
  if (/\s/u.test(previous) && /[.!?…»”)]/u.test(beforePrevious)) return 4;
  if (previous === "\n") return 3;
  if (/\s/u.test(previous)) return 2;
  if (/[.!?…»”)]/u.test(previous) && (!next || /\s/u.test(next))) return 1;
  return 0;
}

/** Split without breaking a surrogate pair, HTML entity or formatting range. */
export function splitTelegramHtml(html, limit = TELEGRAM_TEXT_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError("telegram_limit_invalid");
  const atoms = parseTelegramHtml(html);
  const chunks = [];
  let start = 0;
  while (start < atoms.length) {
    let end = start;
    let length = 0;
    while (end < atoms.length && length + atoms[end].length <= limit) {
      length += atoms[end].length;
      end += 1;
    }
    if (end === atoms.length) {
      chunks.push({ html: renderAtoms(atoms.slice(start)), entityLength: length });
      break;
    }
    let selected = end;
    let bestScore = 0;
    for (let candidate = end; candidate > start; candidate -= 1) {
      const score = boundaryScore(atoms, candidate);
      if (score > bestScore) {
        selected = candidate;
        bestScore = score;
        if (score === 5) break;
      }
    }
    if (selected === start) selected = end;
    const selectedAtoms = atoms.slice(start, selected);
    chunks.push({
      html: renderAtoms(selectedAtoms),
      entityLength: selectedAtoms.reduce((total, atom) => total + atom.length, 0),
    });
    start = selected;
  }
  return chunks;
}

export function telegramHtmlToText(html) {
  return parseTelegramHtml(html).map((atom) => atom.text).join("");
}

/**
 * This is the single final-payload contract used by preflight, preview and worker.
 * A media post above the caption limit sends media first and deterministic text chunks;
 * every chunk remains independently valid Telegram HTML.
 */
export function buildTelegramPayload({ text, entities, hasAsset = false, forceSeparateMedia = false }) {
  const formattedText = entities === undefined ? formatPost(text) : String(text || "");
  const formattedHtml = toTelegramHtml(formattedText, entities);
  const entityLength = telegramEntityLength(formattedHtml);
  let parts;
  if (hasAsset && entityLength <= TELEGRAM_CAPTION_LIMIT && !forceSeparateMedia) {
    parts = [{
      index: 0,
      type: "media_caption",
      payloadHtml: formattedHtml,
      entityLength,
    }];
  } else {
    const textParts = splitTelegramHtml(formattedHtml, TELEGRAM_TEXT_LIMIT);
    const offset = hasAsset ? 1 : 0;
    parts = [
      ...(hasAsset ? [{ index: 0, type: "media", payloadHtml: null, entityLength: 0 }] : []),
      ...textParts.map((part, index) => ({
        index: index + offset,
        type: "text",
        payloadHtml: part.html,
        entityLength: part.entityLength,
      })),
    ];
  }
  return { formattedText, formattedHtml, entityLength, parts };
}

/**
 * Build the immutable provider plan for a native Telegram album. The plan is
 * persisted when publication is scheduled, so the worker must derive the same
 * indexes after a restart instead of replacing a generic single-media plan.
 */
export function buildTelegramCarouselParts({ assetCount, text, entities }) {
  if (!Number.isInteger(assetCount) || assetCount < 3 || assetCount > 7) {
    throw new Error("telegram_carousel_asset_count_invalid");
  }
  const payload = buildTelegramPayload({ hasAsset: true, text, entities });
  const captionPart = payload.parts[0]?.type === "media_caption" ? payload.parts[0] : null;
  const mediaParts = Array.from({ length: assetCount }, (_unused, index) => ({
    index,
    type: "media",
    payloadHtml: index === 0 ? captionPart?.payloadHtml ?? null : null,
    entityLength: index === 0 ? captionPart?.entityLength ?? null : null,
  }));
  const textParts = payload.parts
    .filter((part) => part.type === "text")
    .map((part, index) => ({ ...part, index: assetCount + index }));
  return [...mediaParts, ...textParts];
}
