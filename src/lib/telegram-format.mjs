// Pure final-formatting rules shared by Composer preview, server preflight and worker.
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

export function toTelegramHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|\|([\s\S]+?)\|\|/g, "<tg-spoiler>$1</tg-spoiler>")
    .replace(/\*\*([\s\S]+?)\*\*/g, "<b>$1</b>");
}
