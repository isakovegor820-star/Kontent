/**
 * Минимальный безопасный Markdown → HTML для статей сайта. Поддерживает заголовки
 * (##/###), абзацы, списки, цитаты, **жирный**, *курсив* и ссылки [текст](https://…).
 * Любой HTML во входе экранируется: движок не должен уметь вставить <script> на сайт клиента.
 */

const TRANSLIT = Object.freeze({
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
});

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

export function slugify(value, { maxLength = 80 } = {}) {
  const lower = String(value ?? "").toLocaleLowerCase("ru-RU").trim();
  let out = "";
  for (const char of lower) out += TRANSLIT[char] ?? char;
  return out
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, maxLength)
    .replace(/-+$/u, "");
}

function safeHref(url) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function inline(text) {
  let html = escapeHtml(text);
  html = html.replace(/\[([^\]]{1,200})\]\(([^)\s]{1,500})\)/gu, (_match, label, href) => {
    const safe = safeHref(href);
    return safe ? `<a href="${escapeHtml(safe)}">${label}</a>` : label;
  });
  html = html.replace(/\*\*([^*]{1,300})\*\*/gu, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]{1,300})\*(?!\*)/gu, "$1<em>$2</em>");
  return html;
}

export function renderMarkdown(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/gu, "\n").split("\n");
  const out = [];
  let paragraph = [];
  let list = null;
  let quote = [];

  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote><p>${inline(quote.join(" "))}</p></blockquote>`);
    quote = [];
  };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushAll(); continue; }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(4, Math.max(2, heading[1].length));
      out.push(`<h${level}>${inline(heading[2].trim())}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*•]\s+(.+)$/u.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
    if (bullet || ordered) {
      flushParagraph(); flushQuote();
      const tag = bullet ? "ul" : "ol";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push((bullet || ordered)[1].trim());
      continue;
    }
    const quoted = /^\s*>\s?(.*)$/u.exec(line);
    if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }
    flushList(); flushQuote();
    paragraph.push(line.trim());
  }
  flushAll();
  return out.join("\n");
}

/** Текст без разметки — для description, similarity и подсчёта слов. */
export function markdownToText(markdown) {
  return String(markdown ?? "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[#*>`_]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function extractLinks(markdown) {
  const links = [];
  for (const match of String(markdown ?? "").matchAll(/\[([^\]]{1,200})\]\(([^)\s]{1,500})\)/gu)) {
    links.push({ anchor: match[1], url: match[2] });
  }
  return links;
}

export function countWords(text) {
  return String(text ?? "").split(/\s+/u).filter((word) => /[a-zа-яё0-9]/iu.test(word)).length;
}
