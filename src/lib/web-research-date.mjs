// Определение даты публикации страницы.
//
// Вынесено отдельным модулем, потому что дата нужна в двух местах: в диалоговом
// исследовании и в фоновом обходе. Раньше логика жила только в диалоговом, и фоновый
// контур отбрасывал закон с официального портала как `missing_published_at`, хотя дата
// была прямо в адресе документа.
//
// Модуль чистый: ни сети, ни базы.

function isPlausibleDate(ms, now) {
  if (!Number.isFinite(ms)) return false;
  // Дата в будущем или раньше 2000 года — почти всегда мусор из разметки.
  if (ms > now + 36 * 3_600_000) return false;
  if (ms < Date.parse("2000-01-01T00:00:00Z")) return false;
  return true;
}

const URL_DATE_SEPARATED = [
  /(\d{4})[-_/.](\d{2})[-_/.](\d{2})(?!\d)/u,
];

function plausibleDate(year, month, day, now) {
  const parsed = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const date = new Date(parsed);
  // Отсекаем переполнение вида 2024-13-45, которое Date молча переносит.
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  if (!isPlausibleDate(parsed, now)) return null;
  return date.toISOString();
}

/**
 * Дата из адреса: у официальных порталов она часто есть только в идентификаторе.
 *
 * `publication.pravo.gov.ru/document/0001202412260005` кодирует 2024-12-26 внутри
 * длинного номера, поэтому после явных шаблонов идёт скользящий поиск по восьми
 * цифрам подряд: год 2024 в этой строке находится только так.
 */
export function extractDateFromUrl(value, now = Date.now()) {
  const raw = String(value ?? "");
  if (!raw) return null;
  for (const pattern of URL_DATE_SEPARATED) {
    const match = raw.match(pattern);
    if (match) {
      const found = plausibleDate(match[1], match[2], match[3], now);
      if (found) return found;
    }
  }
  for (let index = 0; index + 8 <= raw.length; index++) {
    const window = raw.slice(index, index + 8);
    if (!/^\d{8}$/u.test(window)) continue;
    const found = plausibleDate(window.slice(0, 4), window.slice(4, 6), window.slice(6, 8), now);
    if (found) return found;
  }
  return null;
}

/**
 * Достаёт дату публикации из разметки или из адреса. Возвращает null, если даты нет
 * или она неправдоподобна — лучше честное «дата неизвестна», чем выдуманная свежесть.
 */
export function extractPublishedAt(html, now = Date.now(), url = null) {
  const source = String(html ?? "").slice(0, 400_000);
  const candidates = [];
  const metaPatterns = [
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:article:published_time|og:published_time|datePublished|date|pubdate|publishdate|dc\.date|dcterms\.created)["'][^>]*>/giu,
  ];
  for (const pattern of metaPatterns) {
    for (const match of source.matchAll(pattern)) {
      const content = match[0].match(/content\s*=\s*["']([^"']+)["']/iu);
      if (content) candidates.push(content[1]);
    }
  }
  for (const match of source.matchAll(/<time[^>]+datetime\s*=\s*["']([^"']+)["']/giu)) {
    candidates.push(match[1]);
  }
  for (const raw of candidates) {
    const parsed = Date.parse(raw.trim());
    if (isPlausibleDate(parsed, now)) return new Date(parsed).toISOString();
  }
  return extractDateFromUrl(url, now);
}
