const UTF8_BOM = [0xef, 0xbb, 0xbf];
const SUPPORTED_ENCODINGS = new Map([
  ["utf-8", "utf-8"],
  ["utf8", "utf-8"],
  ["windows-1251", "windows-1251"],
  ["windows1251", "windows-1251"],
  ["cp1251", "windows-1251"],
  ["win-1251", "windows-1251"],
]);

export class RssDecodingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RssDecodingError";
    this.code = code;
  }
}

function headerValue(headers, name) {
  if (typeof headers?.get === "function") return headers.get(name);
  const wanted = name.toLowerCase();
  const entry = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === wanted);
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(",") : value == null ? null : String(value);
}

function normalizedEncoding(value) {
  const label = String(value || "").trim().toLowerCase().replace(/["']/g, "");
  if (!label) return null;
  const encoding = SUPPORTED_ENCODINGS.get(label);
  if (!encoding) {
    throw new RssDecodingError("unsupported_encoding", `Неподдерживаемая кодировка RSS: ${label.slice(0, 80)}`);
  }
  return encoding;
}

function declaredEncoding(bytes, headers) {
  if (UTF8_BOM.every((byte, index) => bytes[index] === byte)) return "utf-8";
  const contentType = headerValue(headers, "content-type") || "";
  const headerCharset = contentType.match(/charset\s*=\s*["']?([^\s;"']+)/iu)?.[1];
  if (headerCharset) return normalizedEncoding(headerCharset);

  // XML declaration is ASCII-compatible for both supported encodings, so it can be
  // inspected before the document itself is decoded.
  const prefix = Buffer.from(bytes.subarray(0, 512)).toString("latin1");
  const xmlCharset = prefix.match(/<\?xml\b[^>]*\bencoding\s*=\s*["']([^"']+)["']/iu)?.[1];
  return normalizedEncoding(xmlCharset) || "utf-8";
}

export function decodeRssBytes(value, headers = {}) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
  const encoding = declaredEncoding(bytes, headers);
  let text;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new RssDecodingError("invalid_encoding", "RSS не соответствует заявленной кодировке");
  }
  if (text.includes("\uFFFD")) {
    throw new RssDecodingError("invalid_encoding", "RSS содержит повреждённые символы");
  }
  return text.replace(/^\uFEFF/u, "");
}

export async function decodeRssResponse(response) {
  if (typeof response?.bytes === "function") {
    return decodeRssBytes(await response.bytes(), response.headers);
  }
  if (typeof response?.arrayBuffer === "function") {
    return decodeRssBytes(new Uint8Array(await response.arrayBuffer()), response.headers);
  }
  const text = await response.text();
  if (String(text).includes("\uFFFD")) {
    throw new RssDecodingError("invalid_encoding", "RSS уже был декодирован с потерей символов");
  }
  return String(text).replace(/^\uFEFF/u, "");
}
