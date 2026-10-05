// Чистая view-модель «Аврора сходила в интернет» для чата Студии контента.
//
// Сервер отдаёт результат исследования заголовками ответа /api/ai/generate:
// x-aurora-research-status и x-aurora-research (URI-encoded JSON). Заголовки
// приходят раньше тела стрима, поэтому интерфейс успевает честно показать
// «смотрю в интернет», пока текста ещё нет.
//
// Модуль не знает ни про сеть, ни про React: он превращает две строки заголовков
// в безопасную модель для показа. Всё, что не совпало с контрактом, молча
// отбрасывается — сломанный заголовок не должен ломать чат.

/** Причины, по которым блок источников вообще появляется. */
export type StudioResearchStatus = "none" | "ok" | "empty" | "failed";

/** Показываем не больше восьми ссылок: это выжимка под ответом, а не журнал. */
export const STUDIO_RESEARCH_MAX_SOURCES = 8;
export const STUDIO_RESEARCH_MAX_LABEL = 80;
export const STUDIO_RESEARCH_MAX_URL = 2_048;
export const STUDIO_RESEARCH_MAX_TIER = 64;
/**
 * Потолок заголовка — грубая страховка от бесконечного значения, а не граница контракта:
 * кириллица в URI-кодировании раздувается в 9 раз, поэтому даже длинные подписи
 * источников должны доходить до разбора. Режет список уже STUDIO_RESEARCH_MAX_SOURCES.
 */
const STUDIO_RESEARCH_MAX_HEADER = 262_144;

export type StudioResearchSource = {
  label: string;
  url: string;
  /** Дата публикации в виде ДД.ММ.ГГГГ либо null, если сервер её не знает. */
  date: string | null;
  tier: string | null;
};

export type StudioResearchView = {
  status: StudioResearchStatus;
  used: boolean;
  reason: string;
  queries: number;
  pages: number;
  findings: number;
  sources: StudioResearchSource[];
  /** Аврора выходила в интернет, но ничего проверяемого не нашла. */
  nothingVerified: boolean;
  /** Поиск или чтение страниц упали: это сбой, а не пустая выдача. */
  failed: boolean;
  /** Строка счёта: «Запросов: 3 · Страниц: 5 · Подтверждённых фактов: 4». */
  countsLine: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanText(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);
}

function asCount(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

export function studioResearchCountsLine(queries: unknown, pages: unknown, findings: unknown): string {
  const parts = [
    `Запросов: ${asCount(queries)}`,
    `Страниц: ${asCount(pages)}`,
    `Подтверждённых фактов: ${asCount(findings)}`,
  ];
  return parts.join(" · ");
}

/**
 * Статус исследования из заголовка. Неизвестное значение считаем «не ходили»:
 * молчание безопаснее выдуманной строки прогресса.
 */
export function parseStudioResearchStatus(value: unknown): StudioResearchStatus {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "ok" || normalized === "empty" || normalized === "failed") return normalized;
  return "none";
}

/** http/https — единственные схемы, которые мы готовы показать ссылкой. */
function safeSourceUrl(value: unknown): string | null {
  const raw = String(value ?? "").trim().slice(0, STUDIO_RESEARCH_MAX_URL);
  if (!raw) return null;
  if (!/^https?:\/\//iu.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return raw;
}

/**
 * Дата публикации: принимаем только «2026-09-30» и полный ISO, иначе честное null.
 * Дату без времени разбираем как календарную: `new Date("2026-09-30")` — это UTC-полночь,
 * и в западных часовых поясах она показалась бы вчерашним днём.
 */
function safeSourceDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(raw);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : /^\d{4}-\d{2}-\d{2}[T ].+$/u.test(raw)
      ? new Date(raw)
      : null;
  if (!date || !Number.isFinite(date.getTime())) return null;
  // Проверка на «2026-02-31»: JS молча переносит такую дату на март.
  if (dateOnly && (date.getMonth() !== Number(dateOnly[2]) - 1 || date.getDate() !== Number(dateOnly[3]))) {
    return null;
  }
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function safeSource(value: unknown): StudioResearchSource | null {
  if (!isRecord(value)) return null;
  const url = safeSourceUrl(value.url);
  if (!url) return null;
  const label = cleanText(value.label, STUDIO_RESEARCH_MAX_LABEL);
  const tier = cleanText(value.tier, STUDIO_RESEARCH_MAX_TIER);
  return {
    // Если сервер не дал название, показываем домен: ссылка без подписи бесполезна.
    label: label || new URL(url).hostname.replace(/^www\./iu, ""),
    url,
    date: safeSourceDate(value.date),
    tier: tier || null,
  };
}

/** Разбор URI-encoded JSON из заголовка. Любая ошибка — это null, а не исключение. */
function decodeSourcesHeader(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw || raw.length > STUDIO_RESEARCH_MAX_HEADER) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // URI-encoded значения может не быть вовсе — пробуем прочитать как есть.
    decoded = raw;
  }
  try {
    const parsed: unknown = JSON.parse(decoded);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function emptyView(status: StudioResearchStatus): StudioResearchView {
  return {
    status,
    used: false,
    reason: "",
    queries: 0,
    pages: 0,
    findings: 0,
    sources: [],
    nothingVerified: false,
    failed: status === "failed",
    countsLine: studioResearchCountsLine(0, 0, 0),
  };
}

/**
 * Собирает модель показа из заголовков ответа.
 *
 * Возвращает null только когда исследования не было вовсе («none») — в этом
 * случае в интерфейсе не должно появиться ни строки. Во всех остальных случаях
 * возвращается безопасная модель, даже если тело заголовка оказалось мусором.
 */
export function parseStudioResearchHeaders(
  statusHeader: unknown,
  sourcesHeader: unknown,
): StudioResearchView | null {
  const status = parseStudioResearchStatus(statusHeader);
  const payload = decodeSourcesHeader(sourcesHeader);
  if (status === "none" && !payload) return null;

  const view = emptyView(status);
  // Статус говорит, что Аврора выходила в интернет, а тело заголовка не разобралось:
  // верим статусу и честно показываем «искала, но ничего не подтвердила». Для сбоя
  // формулировка другая: обещать «искала» при нуле запросов нельзя.
  if (!payload) {
    return status === "none"
      ? view
      : { ...view, used: true, nothingVerified: status !== "failed" };
  }

  const findings = asCount(payload.findings);
  const sources = (Array.isArray(payload.sources) ? payload.sources : [])
    .map(safeSource)
    .filter((source): source is StudioResearchSource => source !== null)
    .slice(0, STUDIO_RESEARCH_MAX_SOURCES);
  const used = payload.used === true || findings > 0 || sources.length > 0;
  if (!used) {
    // Статус говорит, что Аврора выходила в интернет, а тело заголовка промолчало.
    // Верим статусу: честная строка «искала, но ничего не подтвердила» лучше пустоты.
    if (status !== "none") return { ...view, used: true, nothingVerified: status !== "failed" };
    return view;
  }

  return {
    status,
    used: true,
    reason: cleanText(payload.reason, 300),
    queries: asCount(payload.queries),
    pages: asCount(payload.pages),
    findings,
    sources,
    // Сбой поиска — не «пустая выдача»: даже если заголовок пришёл с used: true и
    // нулём фактов, пользователю нельзя показывать «искала, но не нашла».
    nothingVerified: status !== "failed" && findings === 0 && sources.length === 0,
    failed: status === "failed",
    countsLine: studioResearchCountsLine(payload.queries, payload.pages, findings),
  };
}

/** Подпись строки прогресса. null — прогресс не нужен, показываем обычный стрим. */
export function studioResearchProgressLabel(
  view: StudioResearchView | null | undefined,
  options: { streaming?: boolean; hasText?: boolean } = {},
): string | null {
  // «failed» — поиск уже упал: обещать «смотрит в интернет» нельзя.
  if (!view || view.status === "none" || view.status === "failed") return null;
  if (options.streaming === false) return null;
  if (options.hasText) return null;
  return "Аврора смотрит в интернет…";
}
