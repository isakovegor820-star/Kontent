import { createRequire } from "node:module";

import { renderTabularXlsx, resolveLibraryPdfFontPath } from "./library-export.mjs";

const require = createRequire(import.meta.url);

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
  ["views", "Просмотры", "number"],
  ["reactions", "Реакции", "number"],
  ["comments", "Комментарии", "number"],
  ["shares", "Репосты", "number"],
  ["clicksTotal", "Клики", "number"],
  ["clicksUnique", "Уникальные клики", "number"],
  ["conversions", "Подтверждённые конверсии", "number"],
  ["trackerState", "Трекер сайта", "text"],
  ["postUrl", "Ссылка на пост", "text"],
]);

function columnsFor(snapshot) {
  if (snapshot.kind === "content_plan") return CONTENT_PLAN_COLUMNS;
  if (snapshot.kind === "analytics") return ANALYTICS_COLUMNS;
  throw new Error("unsupported_project_export_kind");
}

function safeString(value) {
  const text = String(value ?? "").replace(/\u0000/gu, "");
  return /^[=+\-@]/u.test(text) ? `'${text}` : text;
}

function typedCell(value, kind) {
  if (kind === "date") {
    const date = value instanceof Date ? value : new Date(String(value ?? ""));
    return Number.isFinite(date.getTime()) ? date : "";
  }
  if (kind === "number") return Number.isFinite(Number(value)) ? Number(value) : 0;
  return safeString(value);
}

function metadata(snapshot) {
  return [
    ["Проект", safeString(snapshot.project?.name)],
    ["Период", `${safeString(snapshot.period?.from)} — ${safeString(snapshot.period?.to)}`],
    ["Часовой пояс", safeString(snapshot.project?.timezone)],
    ["Сформирован", new Date(snapshot.exportedAt)],
    ["Фильтры", safeString(JSON.stringify(snapshot.filters ?? {}))],
    ["Методика", safeString(snapshot.methodology ?? "")],
  ];
}

function table(snapshot) {
  const columns = columnsFor(snapshot);
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  return [
    columns.map(([, label]) => label),
    ...rows.map((row) => columns.map(([key, , type]) => typedCell(row?.[key], type))),
  ];
}

function csvCell(value) {
  const display = value instanceof Date ? value.toISOString() : safeString(value);
  return `"${String(display).replace(/"/gu, '""')}"`;
}

export function renderProjectCsv(snapshot) {
  const rows = [
    ...metadata(snapshot).map((row) => row.map(csvCell).join(",")),
    "",
    ...table(snapshot).map((row) => row.map(csvCell).join(",")),
  ];
  return Buffer.from(`\uFEFF${rows.join("\r\n")}\r\n`, "utf8");
}

export function renderProjectXlsx(snapshot) {
  const meta = metadata(snapshot);
  return renderTabularXlsx(
    [...meta, [], ...table(snapshot)],
    snapshot.kind === "analytics" ? "Аналитика" : "Контент-план",
    { headerRow: meta.length + 2 },
  );
}

export async function renderProjectPdf(snapshot) {
  const PDFDocument = require("pdfkit");
  const title = snapshot.kind === "analytics" ? "Аналитика" : "Контент-план";
  const document = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: 32,
    info: { Title: `${title} — ${safeString(snapshot.project?.name)}` },
  });
  const chunks = [];
  document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise((resolve, reject) => {
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });
  document.registerFont("Aurora", resolveLibraryPdfFontPath());
  document.font("Aurora").fillColor("#0f172a").fontSize(18).text(title);
  document.fontSize(11).text(safeString(snapshot.project?.name));
  document.moveDown(0.4).fontSize(8).fillColor("#475569");
  for (const [label, value] of metadata(snapshot).slice(1)) {
    document.text(`${label}: ${value instanceof Date ? value.toISOString() : safeString(value)}`);
  }
  document.moveDown(0.8);
  const columns = columnsFor(snapshot);
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  if (rows.length === 0) {
    document.fillColor("#0f172a").fontSize(11).text("За выбранный период записей нет.");
  } else {
    rows.forEach((row, index) => {
      if (document.y > document.page.height - 110) document.addPage();
      const heading = row.title || row.channel || `Запись ${index + 1}`;
      document.fillColor("#0f172a").fontSize(10).text(safeString(heading));
      document.fillColor("#475569").fontSize(7.5);
      for (const [key, label, type] of columns) {
        const value = typedCell(row?.[key], type);
        document.text(`${label}: ${value instanceof Date ? value.toISOString() : safeString(value)}`);
      }
      document.moveDown(0.6);
    });
  }
  document.end();
  return done;
}

export async function renderProjectExport(format, snapshot) {
  if (format === "csv") return {
    bytes: renderProjectCsv(snapshot),
    contentType: "text/csv; charset=utf-8",
    extension: "csv",
  };
  if (format === "xlsx") return {
    bytes: renderProjectXlsx(snapshot),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  };
  if (format === "pdf") return {
    bytes: await renderProjectPdf(snapshot),
    contentType: "application/pdf",
    extension: "pdf",
  };
  throw new Error("unsupported_project_export_format");
}

export function projectExportFilename(projectName, kind, period, extension) {
  const safe = String(projectName || "project")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64) || "project";
  const report = kind === "analytics" ? "analytics" : "content-plan";
  const from = /^\d{4}-\d{2}-\d{2}$/u.test(period?.from) ? period.from : "period";
  const to = /^\d{4}-\d{2}-\d{2}$/u.test(period?.to) ? period.to : "period";
  const ext = ["csv", "xlsx", "pdf"].includes(extension) ? extension : "bin";
  return `${safe}-${report}-${from}-${to}.${ext}`;
}
