const ENTITY_TYPES = new Set([
  "bold",
  "italic",
  "underline",
  "strikethrough",
  "code",
  "spoiler",
  "blockquote",
  "link",
]);

export const RICH_TEXT_ENTITY_TYPES = Object.freeze([...ENTITY_TYPES]);
export const MAX_RICH_TEXT_ENTITIES = 512;

function invalid() {
  throw new TypeError("rich_text_entities_invalid");
}

function isUtf16Boundary(text, offset) {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

/**
 * Normalizes a user-entered link and rejects schemes that could execute code.
 * A bare host receives https://, matching the editor's visible behaviour.
 */
export function normalizeRichTextUrl(value) {
  const candidate = String(value || "").trim();
  if (!candidate || candidate.length > 2_048 || /[\u0000-\u001f\u007f]/u.test(candidate)) {
    throw new TypeError("rich_text_url_invalid");
  }
  const withScheme = /^[a-z][a-z\d+.-]*:/iu.test(candidate)
    ? candidate
    : `https://${candidate}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    throw new TypeError("rich_text_url_invalid");
  }
  if (!new Set(["http:", "https:", "mailto:"]).has(url.protocol)) {
    throw new TypeError("rich_text_url_invalid");
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) {
    throw new TypeError("rich_text_url_invalid");
  }
  if (url.protocol === "mailto:" && !url.pathname.includes("@")) {
    throw new TypeError("rich_text_url_invalid");
  }
  return url.href;
}

/** Canonical API/database representation. Offsets use JavaScript/Telegram UTF-16 units. */
export function normalizeRichTextEntities(text, value) {
  const source = String(text || "");
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_RICH_TEXT_ENTITIES) invalid();
  const normalized = value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) invalid();
    const keys = Object.keys(candidate);
    if (keys.some((key) => !["type", "offset", "length", "url"].includes(key))) invalid();
    const type = String(candidate.type || "");
    const offset = Number(candidate.offset);
    const length = Number(candidate.length);
    if (
      !ENTITY_TYPES.has(type)
      || !Number.isSafeInteger(offset)
      || !Number.isSafeInteger(length)
      || offset < 0
      || length <= 0
      || offset + length > source.length
      || !isUtf16Boundary(source, offset)
      || !isUtf16Boundary(source, offset + length)
    ) invalid();
    if (type === "link") {
      return { type, offset, length, url: normalizeRichTextUrl(candidate.url) };
    }
    if (Object.hasOwn(candidate, "url")) invalid();
    return { type, offset, length };
  });

  normalized.sort((left, right) => (
    left.offset - right.offset
    || right.length - left.length
    || left.type.localeCompare(right.type)
    || String(left.url || "").localeCompare(String(right.url || ""))
  ));
  const seen = new Set();
  return normalized.filter((entity) => {
    const key = `${entity.type}\0${entity.offset}\0${entity.length}\0${entity.url || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Keeps only the portion of every entity that is visible inside one text slice. */
export function sliceRichTextEntities(entities, start, end) {
  const from = Math.max(0, Number(start) || 0);
  const to = Math.max(from, Number(end) || 0);
  return entities.flatMap((entity) => {
    const entityStart = entity.offset;
    const entityEnd = entity.offset + entity.length;
    const visibleStart = Math.max(from, entityStart);
    const visibleEnd = Math.min(to, entityEnd);
    if (visibleEnd <= visibleStart) return [];
    return [{
      ...entity,
      offset: visibleStart - from,
      length: visibleEnd - visibleStart,
    }];
  });
}

/** Adjusts ranges for the trim performed by the publication block renderer. */
export function trimRichTextContent(text, entities) {
  const source = String(text || "");
  const trimmed = source.trim();
  if (!trimmed) return { text: "", entities: [] };
  const start = source.indexOf(trimmed);
  return {
    text: trimmed,
    entities: sliceRichTextEntities(entities, start, start + trimmed.length),
  };
}
