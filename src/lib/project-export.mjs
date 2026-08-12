import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import { renderTabularXlsx, resolveLibraryPdfFontPath } from "./library-export.mjs";

const require = createRequire(import.meta.url);

export const PROJECT_EXPORT_FORMATS = Object.freeze(["csv", "xlsx", "pdf"]);
export const PROJECT_EXPORT_KINDS = Object.freeze(["content_plan", "analytics"]);

const SNAPSHOT_VERSION = "aurora-project-export-v1";
const FILTER_KEYS = Object.freeze(["channel", "author", "campaign", "status"]);
const SPREADSHEET_FORMULA_PREFIX = /^[\p{Z}\p{Cc}\p{Cf}]*[=+\-@]/u;

const CONTENT_PLAN_COLUMNS = Object.freeze([
  ["scheduledAt", "Дата и время", "date"],
  ["timezone", "Часовой пояс", "text"],
  ["channel", "Канал", "text"],
  ["rubric", "Рубрика", "text"],
  ["title", "Тема", "text"],
  ["status", "Статус", "text"],
  ["author", "Автор", "text"],
  ["approver", "Согласующий", "text"],
  ["campaign", "Кампания", "text"],
  ["postUrl", "Ссылка на пост", "text"],
  ["utmUrl", "Ссылка с UTM", "text"],
  ["shortUrl", "Короткая ссылка", "text"],
]);

const ANALYTICS_COLUMNS = Object.freeze([
  ["publishedAt", "Дата публикации", "date"],
  ["channel", "Канал", "text"],
  ["campaign", "Кампания", "text"],
  ["title", "Публикация", "text"],
  ["status", "Подтверждение", "text"],
  ["author", "Автор", "text"],
  ["approver", "Согласующий", "text"],
  ["views", "Просмотры", "number"],
  ["reactions", "Реакции", "number"],
  ["comments", "Комментарии", "number"],
  ["shares", "Репосты", "number"],
  ["clicksTotal", "Клики", "number"],
  ["clicksUnique", "Уникальные клики", "number"],
  ["conversions", "Подтверждённые конверсии", "number"],
  ["trackerState", "Трекер сайта", "text"],
  ["postUrl", "Ссылка на пост", "text"],
  ["shortUrl", "Короткая ссылка", "text"],
]);

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value, name) {
  if (!isRecord(value)) throw new Error(`invalid_project_export_${name}`);
  return value;
}

function cleanText(value) {
  return String(value ?? "").replace(/\u0000/gu, "");
}

function optionalText(value) {
  return cleanText(value).trim();
}

function requiredText(value, name) {
  const text = optionalText(value);
  if (!text) throw new Error(`invalid_project_export_${name}`);
  return text;
}

function requiredContentText(value, name) {
  const text = cleanText(value);
  if (!text.trim()) throw new Error(`invalid_project_export_${name}`);
  return text;
}

function normalizeProjectId(value, name = "project_id") {
  return requiredText(value, name);
}

function validDateOnly(value) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function normalizeDateOnly(value, name) {
  const text = String(value ?? "");
  if (!validDateOnly(text)) throw new Error(`invalid_project_export_${name}`);
  return text;
}

function normalizeInstant(value, name) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(String(value ?? ""));
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid_project_export_${name}`);
  return date.toISOString();
}

function normalizeTimezone(value) {
  const timezone = requiredText(value, "timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error("invalid_project_export_timezone");
  }
  return timezone;
}

function localDateKey(instant, timezone) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(instant));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizeFilterValues(value) {
  const list = value == null || value === "" ? [] : Array.isArray(value) ? value : [value];
  const result = [];
  const seen = new Set();
  for (const item of list) {
    const text = optionalText(item).normalize("NFKC");
    const key = text.toLocaleLowerCase("ru-RU");
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function comparisonKey(value) {
  return optionalText(value).normalize("NFKC").toLocaleLowerCase("ru-RU");
}

function matchesFilter(row, key, values) {
  if (values.length === 0) return true;
  const rowValue = comparisonKey(row[key]);
  return values.some((value) => comparisonKey(value) === rowValue);
}

function optionalMetric(value, name) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`invalid_project_export_${name}`);
  return number;
}

function normalizeCommonRow(row, projectId) {
  const input = requiredRecord(row, "row");
  const rowProjectId = optionalText(input.projectId ?? input.project_id);
  if (!rowProjectId || rowProjectId !== projectId) return null;
  return {
    id: optionalText(input.id),
    projectId: rowProjectId,
    channel: requiredText(input.channel, "row_channel"),
    rubric: optionalText(input.rubric),
    title: requiredContentText(input.title, "row_title"),
    status: requiredText(input.status, "row_status"),
    author: optionalText(input.author),
    approver: optionalText(input.approver),
    campaign: optionalText(input.campaign),
    postUrl: optionalText(input.postUrl),
    utmUrl: optionalText(input.utmUrl),
    shortUrl: optionalText(input.shortUrl),
  };
}

function normalizeRow(kind, row, project, period) {
  const common = normalizeCommonRow(row, project.id);
  if (!common) return null;
  if (kind === "content_plan") {
    const scheduledAt = normalizeInstant(row.scheduledAt, "scheduled_at");
    const normalized = {
      ...common,
      scheduledAt,
      timezone: row.timezone ? normalizeTimezone(row.timezone) : project.timezone,
    };
    const dateKey = localDateKey(scheduledAt, project.timezone);
    return dateKey >= period.from && dateKey <= period.to ? normalized : null;
  }
  if (row.confirmed !== true) return null;
  const publishedAt = normalizeInstant(row.publishedAt, "published_at");
  const dateKey = localDateKey(publishedAt, project.timezone);
  if (dateKey < period.from || dateKey > period.to) return null;
  return {
    ...common,
    publishedAt,
    confirmed: true,
    views: optionalMetric(row.views, "views"),
    reactions: optionalMetric(row.reactions, "reactions"),
    comments: optionalMetric(row.comments, "comments"),
    shares: optionalMetric(row.shares, "shares"),
    clicksTotal: optionalMetric(row.clicksTotal, "clicks_total"),
    clicksUnique: optionalMetric(row.clicksUnique, "clicks_unique"),
    conversions: optionalMetric(row.conversions, "conversions"),
    trackerState: optionalText(row.trackerState),
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalValue(nested)]),
    );
  }
  return value;
}

/** Stable SHA-256 used to bind a durable operation to its immutable JSON snapshot. */
export function projectExportHash(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

/**
 * Builds the only input accepted by all three renderers. It takes an immutable copy,
 * enforces the selected project, applies the same period and dimension filters, and
 * keeps unavailable analytics metrics as null rather than inventing zeroes.
 */
export function createProjectExportSnapshot(input) {
  const source = requiredRecord(input, "snapshot");
  const kind = PROJECT_EXPORT_KINDS.includes(source.kind) ? source.kind : null;
  if (!kind) throw new Error("unsupported_project_export_kind");
  const projectInput = requiredRecord(source.project, "project");
  const project = {
    id: normalizeProjectId(projectInput.id),
    name: requiredText(projectInput.name, "project_name"),
    timezone: normalizeTimezone(projectInput.timezone),
  };
  const periodInput = requiredRecord(source.period, "period");
  const period = {
    from: normalizeDateOnly(periodInput.from, "period_from"),
    to: normalizeDateOnly(periodInput.to, "period_to"),
  };
  if (period.from > period.to) throw new Error("invalid_project_export_period_order");
  const filterInput = isRecord(source.filters) ? source.filters : {};
  if (filterInput.projectId != null && String(filterInput.projectId) !== project.id) {
    throw new Error("project_export_filter_project_mismatch");
  }
  const filters = { projectId: project.id };
  for (const key of FILTER_KEYS) filters[key] = normalizeFilterValues(filterInput[key]);
  const methodology = optionalText(source.methodology);
  if (kind === "analytics" && !methodology) throw new Error("invalid_project_export_methodology");
  const rows = [];
  for (const row of Array.isArray(source.rows) ? source.rows : []) {
    const normalized = normalizeRow(kind, row, project, period);
    if (!normalized) continue;
    if (FILTER_KEYS.every((key) => matchesFilter(normalized, key, filters[key]))) rows.push(normalized);
  }
  return deepFreeze({
    schemaVersion: SNAPSHOT_VERSION,
    kind,
    exportedAt: normalizeInstant(source.exportedAt, "exported_at"),
    project,
    period,
    filters,
    methodology,
    rows,
  });
}

function columnsFor(snapshot) {
  if (snapshot.kind === "content_plan") return CONTENT_PLAN_COLUMNS;
  if (snapshot.kind === "analytics") return ANALYTICS_COLUMNS;
  throw new Error("unsupported_project_export_kind");
}

export function escapeSpreadsheetFormula(value) {
  const text = cleanText(value);
  const normalized = text.normalize("NFKC");
  return SPREADSHEET_FORMULA_PREFIX.test(normalized) ? `'${text}` : text;
}

function typedCell(value, type, spreadsheet = true) {
  if (type === "date") {
    const date = new Date(String(value ?? ""));
    return Number.isFinite(date.getTime()) ? date : "";
  }
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? value : "";
  return spreadsheet ? escapeSpreadsheetFormula(value) : cleanText(value);
}

function filterLabel(values) {
  return values.length > 0 ? values.join(", ") : "Все";
}

function metadataRows(snapshot, spreadsheet = true) {
  const text = (value) => spreadsheet ? escapeSpreadsheetFormula(value) : cleanText(value);
  return [
    ["Проект", text(snapshot.project.name)],
    ["Период", `${snapshot.period.from} - ${snapshot.period.to}`],
    ["Часовой пояс", text(snapshot.project.timezone)],
    ["Сформирован", new Date(snapshot.exportedAt)],
    ["Каналы", text(filterLabel(snapshot.filters.channel))],
    ["Авторы", text(filterLabel(snapshot.filters.author))],
    ["Кампании", text(filterLabel(snapshot.filters.campaign))],
    ["Статусы", text(filterLabel(snapshot.filters.status))],
    ["Записей", snapshot.rows.length],
    ["Методика", text(snapshot.methodology || "Выборка сформирована по указанному проекту, периоду и фильтрам.")],
  ];
}

function tableRows(snapshot, spreadsheet = true) {
  const columns = columnsFor(snapshot);
  return [
    columns.map(([, label]) => label),
    ...snapshot.rows.map((row) => columns.map(([key, , type]) => typedCell(row[key], type, spreadsheet))),
  ];
}

function csvCell(value) {
  const display = value instanceof Date ? value.toISOString() : escapeSpreadsheetFormula(value);
  return `"${String(display).replace(/"/gu, '""')}"`;
}

function renderNormalizedCsv(snapshot) {
  const rows = [
    ...metadataRows(snapshot).map((row) => row.map(csvCell).join(",")),
    "",
    ...tableRows(snapshot).map((row) => row.map(csvCell).join(",")),
  ];
  return Buffer.from(`\uFEFF${rows.join("\r\n")}\r\n`, "utf8");
}

export function renderProjectCsv(input) {
  return renderNormalizedCsv(createProjectExportSnapshot(input));
}

function renderNormalizedXlsx(snapshot) {
  const metadata = metadataRows(snapshot);
  return renderTabularXlsx(
    [...metadata, [], ...tableRows(snapshot)],
    snapshot.kind === "analytics" ? "Аналитика" : "Контент-план",
    { headerRow: metadata.length + 2 },
  );
}

export function renderProjectXlsx(input) {
  return renderNormalizedXlsx(createProjectExportSnapshot(input));
}

function pdfDate(value, timezone) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function pdfValue(value, type, timezone) {
  if (type === "date") return pdfDate(value, timezone);
  if (type === "number") return value == null ? "Нет данных" : String(value);
  return cleanText(value) || "-";
}

function drawPdfPageHeader(document, title, snapshot, continued = false) {
  const width = document.page.width - document.page.margins.left - document.page.margins.right;
  document.fillColor("#0f172a").fontSize(continued ? 11 : 18).text(title, { width });
  document.fontSize(continued ? 8 : 11).text(snapshot.project.name, { width });
  if (continued) document.moveDown(0.4);
}

function ensurePdfSpace(document, height) {
  const bottom = document.page.height - document.page.margins.bottom - 20;
  if (document.y + height > bottom) document.addPage();
}

function pdfRowHeight(document, row, columns, snapshot) {
  const width = document.page.width - document.page.margins.left - document.page.margins.right;
  let height = document.fontSize(10.5).heightOfString(`1. ${cleanText(row.title)}`, { width });
  document.fontSize(8);
  for (const [key, label, type] of columns) {
    height += document.heightOfString(`${label}: ${pdfValue(row[key], type, snapshot.project.timezone)}`, { width });
  }
  return height + 12;
}

async function renderNormalizedPdf(snapshot) {
  const PDFDocument = require("pdfkit");
  const title = snapshot.kind === "analytics" ? "Аналитика" : "Контент-план";
  const document = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: 34,
    bufferPages: true,
    info: {
      Title: `${title} - ${cleanText(snapshot.project.name)}`,
      CreationDate: new Date(snapshot.exportedAt),
      ModDate: new Date(snapshot.exportedAt),
    },
  });
  const chunks = [];
  document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise((resolve, reject) => {
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });
  document.registerFont("Aurora", resolveLibraryPdfFontPath());
  document.font("Aurora");
  document.on("pageAdded", () => drawPdfPageHeader(document, title, snapshot, true));
  drawPdfPageHeader(document, title, snapshot);
  document.moveDown(0.5).fontSize(8.5).fillColor("#475569");
  const details = [
    `Период: ${snapshot.period.from} - ${snapshot.period.to}`,
    `Часовой пояс: ${snapshot.project.timezone}`,
    `Сформирован: ${pdfDate(snapshot.exportedAt, snapshot.project.timezone)}`,
    `Каналы: ${filterLabel(snapshot.filters.channel)}`,
    `Авторы: ${filterLabel(snapshot.filters.author)}`,
    `Кампании: ${filterLabel(snapshot.filters.campaign)}`,
    `Статусы: ${filterLabel(snapshot.filters.status)}`,
    `Записей: ${snapshot.rows.length}`,
  ];
  for (const line of details) document.text(line);
  document.moveDown(0.5).fillColor("#0f172a").fontSize(9).text(`Методика: ${snapshot.methodology || "Выборка сформирована по указанному проекту, периоду и фильтрам."}`);
  document.moveDown(0.8);
  const columns = columnsFor(snapshot);
  if (snapshot.rows.length === 0) {
    document.fontSize(11).text("За выбранный период записей нет.");
  } else {
    for (const [index, row] of snapshot.rows.entries()) {
      ensurePdfSpace(document, pdfRowHeight(document, row, columns, snapshot));
      document.fillColor("#0f172a").fontSize(10.5).text(`${index + 1}. ${cleanText(row.title)}`);
      document.fillColor("#475569").fontSize(8);
      for (const [key, label, type] of columns) {
        const line = `${label}: ${pdfValue(row[key], type, snapshot.project.timezone)}`;
        const height = document.heightOfString(line, { width: document.page.width - 68 });
        ensurePdfSpace(document, Math.max(12, height));
        document.text(line);
      }
      document.moveDown(0.65);
    }
  }
  const range = document.bufferedPageRange();
  for (let index = range.start; index < range.start + range.count; index += 1) {
    document.switchToPage(index);
    const page = document.page;
    document.fillColor("#64748b").fontSize(7.5).text(
      `Страница ${index - range.start + 1} из ${range.count}`,
      page.margins.left,
      page.height - page.margins.bottom - 10,
      { align: "right", lineBreak: false, width: page.width - page.margins.left - page.margins.right },
    );
  }
  document.end();
  return done;
}

export async function renderProjectPdf(input) {
  return renderNormalizedPdf(createProjectExportSnapshot(input));
}

export async function renderProjectExport(format, input) {
  const snapshot = createProjectExportSnapshot(input);
  if (format === "csv") return {
    bytes: renderNormalizedCsv(snapshot),
    contentType: "text/csv; charset=utf-8",
    extension: "csv",
  };
  if (format === "xlsx") return {
    bytes: renderNormalizedXlsx(snapshot),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  };
  if (format === "pdf") return {
    bytes: await renderNormalizedPdf(snapshot),
    contentType: "application/pdf",
    extension: "pdf",
  };
  throw new Error("unsupported_project_export_format");
}

function safeFilenameStem(value) {
  const stem = cleanText(value || "project")
    .normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[<>:"/\\|?*]+/gu, "-")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[. _-]+|[. _-]+$/gu, "");
  const bounded = [...stem].slice(0, 64).join("") || "project";
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(bounded) ? `project-${bounded}` : bounded;
}

export function projectExportFilename(projectName, kind, period, extension) {
  const project = safeFilenameStem(projectName);
  const report = kind === "analytics" ? "analytics" : "content-plan";
  const from = validDateOnly(period?.from) ? period.from : "period";
  const to = validDateOnly(period?.to) ? period.to : "period";
  const ext = PROJECT_EXPORT_FORMATS.includes(extension) ? extension : "bin";
  return `${project}-${report}-${from}-${to}.${ext}`;
}

function encodeRfc5987(value) {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function projectExportContentDisposition(filename) {
  const safe = safeFilenameStem(String(filename).replace(/\.(csv|xlsx|pdf|bin)$/iu, ""));
  const extensionMatch = String(filename).match(/\.(csv|xlsx|pdf|bin)$/iu);
  const extension = extensionMatch ? extensionMatch[1].toLowerCase() : "bin";
  const unicodeFilename = `${safe}.${extension}`;
  const asciiStem = safe
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[._-]+|[._-]+$/gu, "") || "aurora-export";
  const fallback = `${asciiStem}.${extension}`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(unicodeFilename)}`;
}
