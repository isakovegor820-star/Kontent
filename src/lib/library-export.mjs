import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const LIBRARY_EXPORT_FORMATS = Object.freeze([
  "csv",
  "xlsx",
  "json",
  "pdf",
  "html",
  "markdown",
]);

const COLUMNS = Object.freeze([
  ["kind", "Тип"],
  ["text", "Текст"],
  ["channelTitle", "Канал"],
  ["sourceTitle", "Источник"],
  ["sourceUrl", "Оригинал"],
  ["sourceData", "Источник данных"],
  ["postedAt", "Дата публикации"],
  ["views", "Просмотры"],
  ["reactions", "Реакции"],
  ["lift", "Прирост"],
  ["erBayes", "Скорректированная вовлечённость"],
  ["velocity", "Скорость"],
  ["velocityZ", "Отклонение скорости"],
  ["freshness", "Свежесть"],
  ["analyticsScore", "Оценка 0–100"],
  ["userRating", "Оценка 1–5"],
  ["dataQuality", "Качество данных"],
  ["dataMaturity", "Зрелость данных"],
  ["formulaVersion", "Версия формулы"],
]);

const encoder = new TextEncoder();
const require = createRequire(import.meta.url);

/**
 * Resolve the bundled Unicode font at runtime. A direct
 * `require.resolve(".../Geist-Regular.ttf")` makes Turbopack treat the TTF as a JS module
 * while compiling the route, so even non-PDF snapshot creation fails in `npm run dev`.
 */
export function resolveLibraryPdfFontPath({
  cwd = process.cwd(),
  moduleResolve = require.resolve,
  exists = existsSync,
} = {}) {
  const configured = String(process.env.AURORA_PDF_FONT_PATH || "").trim();
  const candidates = configured ? [configured] : [];
  candidates.push(resolve(cwd, "node_modules", "next", "dist", "compiled", "@vercel", "og", "Geist-Regular.ttf"));
  try {
    const nextPackage = moduleResolve(["next", "package.json"].join("/"));
    candidates.push(resolve(dirname(nextPackage), "dist", "compiled", "@vercel", "og", "Geist-Regular.ttf"));
  } catch {
    // The explicit project-relative candidate still works in the normal deployment.
  }
  const fontPath = candidates.find((candidate) => exists(candidate));
  if (!fontPath) throw new Error("library_pdf_unicode_font_unavailable");
  return fontPath;
}

function spreadsheetSafe(value) {
  if (typeof value !== "string") return value;
  return /^[=+\-@]/u.test(value) ? `'${value}` : value;
}

function displayValue(value) {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return spreadsheetSafe(String(value).replace(/\u0000/gu, ""));
}

function metadataRows(snapshot) {
  return [
    ["Дата экспорта", snapshot.exportedAt],
    ["Активные фильтры", JSON.stringify(snapshot.activeFilters ?? {})],
    ["Версия формулы", snapshot.formulaVersion ?? ""],
    ["Количество записей", Array.isArray(snapshot.items) ? snapshot.items.length : 0],
  ];
}

function tableRows(snapshot) {
  return [
    COLUMNS.map(([, label]) => label),
    ...(Array.isArray(snapshot.items) ? snapshot.items : []).map((item) =>
      COLUMNS.map(([key]) => displayValue(item?.[key])),
    ),
  ];
}

function csvCell(value) {
  const text = String(displayValue(value));
  return `"${text.replace(/"/gu, '""')}"`;
}

export function renderLibraryCsv(snapshot) {
  const rows = [
    ...metadataRows(snapshot).map((row) => row.map(csvCell).join(",")),
    "",
    ...tableRows(snapshot).map((row) => row.map(csvCell).join(",")),
  ];
  return Buffer.from(`\uFEFF${rows.join("\r\n")}\r\n`, "utf8");
}

export function renderLibraryJson(snapshot) {
  return Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

function escapeHtml(value) {
  return String(displayValue(value))
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

export function renderLibraryHtml(snapshot) {
  const meta = metadataRows(snapshot)
    .map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");
  const rows = tableRows(snapshot);
  const header = rows[0].map((value) => `<th scope="col">${escapeHtml(value)}</th>`).join("");
  const body = rows
    .slice(1)
    .map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`)
    .join("");
  return Buffer.from(
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Идеи и примеры — экспорт</title>` +
      `<style>body{font:14px/1.5 system-ui,sans-serif;margin:32px;color:#0f172a}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px}dt{font-weight:700}dd{margin:0}table{border-collapse:collapse;width:100%;margin-top:24px}th,td{border:1px solid #cbd5e1;padding:8px;text-align:start;vertical-align:top}th{background:#f8fafc}</style>` +
      `</head><body><h1>Идеи и примеры</h1><dl>${meta}</dl><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></body></html>`,
    "utf8",
  );
}

function markdownCell(value) {
  return String(displayValue(value)).replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, "<br>");
}

export function renderLibraryMarkdown(snapshot) {
  const meta = metadataRows(snapshot).map(([key, value]) => `- **${key}:** ${markdownCell(value)}`).join("\n");
  const rows = tableRows(snapshot);
  const header = `| ${rows[0].map(markdownCell).join(" | ")} |`;
  const separator = `| ${rows[0].map(() => "---").join(" | ")} |`;
  const body = rows.slice(1).map((row) => `| ${row.map(markdownCell).join(" | ")} |`).join("\n");
  return Buffer.from(`# Идеи и примеры\n\n${meta}\n\n${header}\n${separator}\n${body}\n`, "utf8");
}

function xmlText(value) {
  return String(displayValue(value))
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function columnName(index) {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function xlsxCell(value, rowIndex, columnIndex, headerRow) {
  const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const serial = value.getTime() / 86_400_000 + 25_569;
    return `<c r="${ref}" s="1"><v>${serial}</v></c>`;
  }
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  const style = rowIndex + 1 === headerRow ? ' s="2"' : "";
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(value)}</t></is></c>`;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value >>> 0);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

/** Minimal deterministic, store-only ZIP writer; XLSX does not require compression. */
export function createStoreZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = encoder.encode(name);
    const data = typeof content === "string" ? encoder.encode(content) : content;
    const checksum = crc32(data);
    const local = Buffer.concat([
      Buffer.from("504b0304", "hex"),
      u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(checksum), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
      Buffer.from(nameBytes), Buffer.from(data),
    ]);
    locals.push(local);
    centrals.push(Buffer.concat([
      Buffer.from("504b0102", "hex"),
      u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(checksum), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), Buffer.from(nameBytes),
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([
    ...locals,
    central,
    Buffer.from("504b0506", "hex"),
    u16(0), u16(0), u16(files.length), u16(files.length), u32(central.length), u32(offset), u16(0),
  ]);
}

export function renderTabularXlsx(rows, sheetName = "Экспорт", options = {}) {
  const safeSheetName = String(sheetName || "Экспорт").replace(/[\\/*?:\[\]]/gu, " ").slice(0, 31) || "Экспорт";
  const headerRow = Number.isInteger(options.headerRow) && options.headerRow >= 1 && options.headerRow <= rows.length
    ? options.headerRow
    : 1;
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, columnIndex) => {
    const max = rows.reduce((current, row) => {
      const value = row[columnIndex];
      const display = value instanceof Date ? value.toISOString() : String(displayValue(value));
      return Math.max(current, ...display.split(/[\r\n]/u).map((line) => [...line].length));
    }, 0);
    return Math.min(Math.max(max + 2, 10), 60);
  });
  const columns = widths.map((width, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`
  ).join("");
  const sheetRows = rows.map((row, rowIndex) =>
    `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => xlsxCell(value, rowIndex, columnIndex, headerRow)).join("")}</row>`,
  ).join("");
  const lastColumn = columnName(columnCount - 1);
  const autoFilter = rows.length >= headerRow
    ? `<autoFilter ref="A${headerRow}:${lastColumn}${Math.max(rows.length, headerRow)}"/>`
    : "";
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${columns}</cols><sheetData>${sheetRows}</sheetData>${autoFilter}</worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  return createStoreZip([
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlText(safeSheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", styles],
    ["xl/worksheets/sheet1.xml", sheet],
  ]);
}

export function renderLibraryXlsx(snapshot) {
  return renderTabularXlsx([
    ...metadataRows(snapshot),
    [],
    ...tableRows(snapshot),
  ], "Идеи и примеры", { headerRow: metadataRows(snapshot).length + 2 });
}

export function libraryPdfItemLines(item) {
  return COLUMNS
    .filter(([key]) => key !== "text")
    .map(([key, label]) => `${label}: ${displayValue(item?.[key])}`);
}

export async function renderLibraryPdf(snapshot) {
  const PDFDocument = require("pdfkit");
  const fontPath = resolveLibraryPdfFontPath();
  const document = new PDFDocument({ size: "A4", margin: 36, info: { Title: "Идеи и примеры" } });
  const chunks = [];
  document.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const done = new Promise((resolve, reject) => {
    document.once("end", () => resolve(Buffer.concat(chunks)));
    document.once("error", reject);
  });
  document.registerFont("Aurora", fontPath);
  document.font("Aurora").fontSize(18).text("Идеи и примеры");
  document.moveDown(0.5).fontSize(9);
  for (const [key, value] of metadataRows(snapshot)) document.text(`${key}: ${displayValue(value)}`);
  document.moveDown();
  for (const item of Array.isArray(snapshot.items) ? snapshot.items : []) {
    if (document.y > document.page.height - 180) document.addPage();
    document.fontSize(11).text(String(displayValue(item.sourceTitle || item.channelTitle || item.kind)), { continued: false });
    document.fontSize(7.5).fillColor("#475569");
    for (const line of libraryPdfItemLines(item)) document.text(line);
    document.fillColor("#0f172a").fontSize(9).text(`Текст: ${String(displayValue(item.text)).slice(0, 1200)}`);
    if (item.sourceUrl) document.fillColor("#4f46e5").text(`Открыть оригинал: ${String(item.sourceUrl)}`, { link: String(item.sourceUrl), underline: true });
    document.fillColor("#0f172a").moveDown(0.7);
  }
  document.end();
  return done;
}

export async function renderLibraryExport(format, snapshot) {
  switch (format) {
    case "csv": return { bytes: renderLibraryCsv(snapshot), contentType: "text/csv; charset=utf-8", extension: "csv" };
    case "xlsx": return { bytes: renderLibraryXlsx(snapshot), contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", extension: "xlsx" };
    case "json": return { bytes: renderLibraryJson(snapshot), contentType: "application/json; charset=utf-8", extension: "json" };
    case "pdf": return { bytes: await renderLibraryPdf(snapshot), contentType: "application/pdf", extension: "pdf" };
    case "html": return { bytes: renderLibraryHtml(snapshot), contentType: "text/html; charset=utf-8", extension: "html" };
    case "markdown": return { bytes: renderLibraryMarkdown(snapshot), contentType: "text/markdown; charset=utf-8", extension: "md" };
    default: throw new Error("unsupported_export_format");
  }
}
