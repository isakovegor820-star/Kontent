import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createProjectExportSnapshot,
  escapeSpreadsheetFormula,
  projectExportContentDisposition,
  projectExportFilename,
  projectExportHash,
  renderProjectExport,
} from "./project-export.mjs";

function parseCsv(buffer) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/u, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\r" && text[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += 1;
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function decodeXml(value) {
  return String(value)
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&gt;/gu, ">")
    .replace(/&lt;/gu, "<")
    .replace(/&amp;/gu, "&");
}

function columnIndex(reference) {
  const letters = reference.match(/^[A-Z]+/u)?.[0] || "A";
  return [...letters].reduce((result, letter) => result * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function parseSheetXml(xml) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)) {
      const attributes = cellMatch[1];
      const body = cellMatch[2];
      const reference = attributes.match(/\br="([A-Z]+\d+)"/u)?.[1] || "A1";
      const inline = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/u)?.[1];
      const raw = inline == null ? body.match(/<v>([\s\S]*?)<\/v>/u)?.[1] ?? "" : inline;
      row[columnIndex(reference)] = {
        attributes,
        value: decodeXml(raw),
      };
    }
    rows.push(row);
  }
  return rows;
}

function inspectXlsx(buffer) {
  const directory = mkdtempSync(join(tmpdir(), "aurora-project-export-xlsx-"));
  const file = join(directory, "report.xlsx");
  try {
    writeFileSync(file, buffer);
    const validation = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
    const sheet = execFileSync("unzip", ["-p", file, "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
    const styles = execFileSync("unzip", ["-p", file, "xl/styles.xml"], { encoding: "utf8" });
    return { validation, sheet, styles, rows: parseSheetXml(sheet) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function inspectPdf(buffer) {
  const directory = mkdtempSync(join(tmpdir(), "aurora-project-export-pdf-"));
  const file = join(directory, "report.pdf");
  try {
    writeFileSync(file, buffer);
    const info = execFileSync("pdfinfo", [file], { encoding: "utf8" });
    const text = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
    return { info, text };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function analyticsInput() {
  return {
    kind: "analytics",
    exportedAt: "2026-08-11T10:00:00.000Z",
    project: { id: 7, name: "ТехнологИИ Права", timezone: "Europe/Moscow" },
    period: { from: "2026-08-01", to: "2026-08-31" },
    filters: {
      projectId: 7,
      channel: "Telegram",
      author: ["Ирина"],
      campaign: "Банкротство",
      status: "Подтверждено площадкой",
    },
    methodology: "Учитываются подтверждённые площадкой публикации. Метрики без ответа площадки остаются пустыми.",
    rows: [
      {
        id: "publication-1",
        projectId: 7,
        publishedAt: "2026-08-10T09:30:00.000Z",
        confirmed: true,
        channel: "Telegram",
        campaign: "Банкротство",
        title: "=Пять действий директора",
        status: "Подтверждено площадкой",
        author: "Ирина",
        approver: "Алексей",
        views: 1250,
        reactions: 84,
        comments: null,
        shares: 7,
        clicksTotal: 31,
        clicksUnique: 24,
        conversions: 3,
        trackerState: "Подключён",
        postUrl: "https://t.me/example/42",
        shortUrl: "https://aurora.example/r/one",
      },
      { id: "other-project", projectId: 8, publishedAt: "2026-08-10T09:30:00Z", confirmed: true, channel: "Telegram", campaign: "Банкротство", title: "Чужой проект", status: "Подтверждено площадкой", author: "Ирина", views: 999999 },
      { id: "outside-period", projectId: 7, publishedAt: "2026-09-01T09:30:00Z", confirmed: true, channel: "Telegram", campaign: "Банкротство", title: "Другой период", status: "Подтверждено площадкой", author: "Ирина" },
      { id: "other-channel", projectId: 7, publishedAt: "2026-08-10T09:30:00Z", confirmed: true, channel: "VK", campaign: "Банкротство", title: "Другой канал", status: "Подтверждено площадкой", author: "Ирина" },
      { id: "other-author", projectId: 7, publishedAt: "2026-08-10T09:30:00Z", confirmed: true, channel: "Telegram", campaign: "Банкротство", title: "Другой автор", status: "Подтверждено площадкой", author: "Олег" },
      { id: "unconfirmed", projectId: 7, publishedAt: "2026-08-10T09:30:00Z", confirmed: false, channel: "Telegram", campaign: "Банкротство", title: "Не подтверждено", status: "Подтверждено площадкой", author: "Ирина" },
    ],
  };
}

describe("project export snapshot contract", () => {
  it("takes an immutable copy and applies project, local period, channel, author, campaign and status once", () => {
    const input = analyticsInput();
    const snapshot = createProjectExportSnapshot(input);
    expect(snapshot.schemaVersion).toBe("aurora-project-export-v1");
    expect(snapshot.project.id).toBe("7");
    expect(snapshot.filters).toEqual({
      projectId: "7",
      channel: ["Telegram"],
      author: ["Ирина"],
      campaign: ["Банкротство"],
      status: ["Подтверждено площадкой"],
    });
    expect(snapshot.rows.map((row) => row.id)).toEqual(["publication-1"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rows)).toBe(true);
    expect(Object.isFrozen(snapshot.rows[0])).toBe(true);
    input.rows[0].title = "Изменено после снимка";
    expect(snapshot.rows[0].title).toBe("=Пять действий директора");
    expect(() => snapshot.rows.push({})).toThrow();
  });

  it("uses the project timezone for inclusive content-plan period filtering", () => {
    const snapshot = createProjectExportSnapshot({
      kind: "content_plan",
      exportedAt: "2026-08-01T00:00:00Z",
      project: { id: "legal", name: "Право", timezone: "Europe/Moscow" },
      period: { from: "2026-08-01", to: "2026-08-01" },
      filters: { channel: "Telegram", author: "Анна", campaign: "Налоги", status: "Запланирован" },
      rows: [
        { id: "local-boundary", projectId: "legal", scheduledAt: "2026-07-31T21:30:00Z", channel: "Telegram", title: "Локальное 1 августа", status: "Запланирован", author: "Анна", campaign: "Налоги" },
        { id: "utc-next-day", projectId: "legal", scheduledAt: "2026-08-01T21:30:00Z", channel: "Telegram", title: "Локальное 2 августа", status: "Запланирован", author: "Анна", campaign: "Налоги" },
      ],
    });
    expect(snapshot.rows.map((row) => row.id)).toEqual(["local-boundary"]);
    expect(snapshot.rows[0].timezone).toBe("Europe/Moscow");
  });

  it("fails closed on a mismatched project filter and malformed selected metrics", () => {
    expect(() => createProjectExportSnapshot({
      ...analyticsInput(),
      filters: { ...analyticsInput().filters, projectId: 999 },
    })).toThrow("project_export_filter_project_mismatch");
    const malformed = analyticsInput();
    malformed.rows[0].views = -1;
    expect(() => createProjectExportSnapshot(malformed)).toThrow("invalid_project_export_views");
  });

  it("hashes equivalent JSON snapshots deterministically", () => {
    expect(projectExportHash({ b: 2, a: { y: 2, x: 1 } }))
      .toBe(projectExportHash({ a: { x: 1, y: 2 }, b: 2 }));
  });
});

describe("project CSV/XLSX/PDF renderers", () => {
  it("opens and parses all three formats from the same filtered selection", async () => {
    const snapshot = createProjectExportSnapshot(analyticsInput());
    const [csv, xlsx, pdf] = await Promise.all([
      renderProjectExport("csv", snapshot),
      renderProjectExport("xlsx", snapshot),
      renderProjectExport("pdf", snapshot),
    ]);

    expect(csv.bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const csvRows = parseCsv(csv.bytes);
    const csvHeaderIndex = csvRows.findIndex((row) => row[0] === "Дата публикации");
    expect(csvHeaderIndex).toBeGreaterThan(0);
    expect(csvRows[csvHeaderIndex + 1]).toContain("'=Пять действий директора");
    expect(csvRows.flat().join("\n")).not.toContain("Чужой проект");

    const workbook = inspectXlsx(xlsx.bytes);
    expect(workbook.validation).toContain("No errors detected");
    expect(workbook.sheet).toContain('<pane ySplit="12"');
    expect(workbook.sheet).toMatch(/<autoFilter ref="A12:Q13"\/>/u);
    expect(workbook.sheet).toContain('customWidth="1"');
    expect(workbook.sheet).not.toContain("<f>");
    expect(workbook.styles).toContain('formatCode="yyyy-mm-dd hh:mm"');
    const xlsxHeaderIndex = workbook.rows.findIndex((row) => row[0]?.value === "Дата публикации");
    const header = workbook.rows[xlsxHeaderIndex].map((cell) => cell?.value);
    const data = workbook.rows[xlsxHeaderIndex + 1];
    expect(data[header.indexOf("Публикация")].value).toBe("'=Пять действий директора");
    expect(data[header.indexOf("Дата публикации")].attributes).toContain('s="1"');
    expect(data[header.indexOf("Просмотры")]).toMatchObject({ value: "1250" });
    expect(data[header.indexOf("Просмотры")].attributes).not.toContain('t="inlineStr"');
    expect(data[header.indexOf("Комментарии")].value).toBe("");

    const parsedPdf = inspectPdf(pdf.bytes);
    expect(parsedPdf.info).toMatch(/^Pages:\s+1$/mu);
    expect(parsedPdf.text).toContain("ТехнологИИ Права");
    expect(parsedPdf.text).toContain("Пять действий директора");
    expect(parsedPdf.text).toContain("Учитываются подтверждённые площадкой публикации");
    expect(parsedPdf.text).not.toContain("Чужой проект");
    expect(parsedPdf.text).not.toContain("Не подтверждено");
  }, 15_000);

  it("neutralizes formulas after spaces, line breaks and Unicode controls in CSV and XLSX", async () => {
    const payloads = [
      "   =SUM(1,1)",
      "\t+cmd|' /C calc'!A0",
      "\r\n-2+3",
      "\u200B@HYPERLINK(\"https://invalid.test\")",
      "\uFEFF＝1+1",
      "\u0000=WEBSERVICE(\"https://invalid.test\")",
    ];
    for (const payload of payloads) expect(escapeSpreadsheetFormula(payload)).toMatch(/^'/u);
    expect(escapeSpreadsheetFormula("Пояснение = не формула")).toBe("Пояснение = не формула");
    const input = {
      kind: "content_plan",
      exportedAt: "2026-08-11T10:00:00Z",
      project: { id: "secure", name: "Безопасный экспорт", timezone: "UTC" },
      period: { from: "2026-08-11", to: "2026-08-11" },
      rows: payloads.map((title, index) => ({
        id: String(index),
        projectId: "secure",
        scheduledAt: `2026-08-11T${String(index).padStart(2, "0")}:00:00Z`,
        channel: "Telegram",
        title,
        status: "Черновик",
      })),
    };
    const [csv, xlsx] = await Promise.all([
      renderProjectExport("csv", input),
      renderProjectExport("xlsx", input),
    ]);
    const csvRows = parseCsv(csv.bytes);
    const csvHeaderIndex = csvRows.findIndex((row) => row[0] === "Дата и время");
    const titleIndex = csvRows[csvHeaderIndex].indexOf("Тема");
    expect(csvRows.slice(csvHeaderIndex + 1).map((row) => row[titleIndex])).toHaveLength(payloads.length);
    for (const value of csvRows.slice(csvHeaderIndex + 1).map((row) => row[titleIndex])) expect(value).toMatch(/^'/u);

    const workbook = inspectXlsx(xlsx.bytes);
    expect(workbook.sheet).not.toContain("<f>");
    const xlsxHeaderIndex = workbook.rows.findIndex((row) => row[0]?.value === "Дата и время");
    const xlsxTitleIndex = workbook.rows[xlsxHeaderIndex].findIndex((cell) => cell?.value === "Тема");
    for (const row of workbook.rows.slice(xlsxHeaderIndex + 1)) expect(row[xlsxTitleIndex].value).toMatch(/^'/u);
  });

  it("returns valid, parseable empty reports rather than an error", async () => {
    const empty = analyticsInput();
    empty.filters.channel = "Нет такого канала";
    const [csv, xlsx, pdf] = await Promise.all([
      renderProjectExport("csv", empty),
      renderProjectExport("xlsx", empty),
      renderProjectExport("pdf", empty),
    ]);
    const csvRows = parseCsv(csv.bytes);
    const headerIndex = csvRows.findIndex((row) => row[0] === "Дата публикации");
    expect(csvRows).toHaveLength(headerIndex + 1);
    const workbook = inspectXlsx(xlsx.bytes);
    expect(workbook.sheet).toContain('<autoFilter ref="A12:Q12"/>');
    expect(inspectPdf(pdf.bytes).text).toContain("За выбранный период записей нет.");
  });
});

describe("project export download names", () => {
  it("builds bounded filenames and RFC 5987 Content-Disposition without header or path injection", () => {
    const filename = projectExportFilename(
      "ООО / Право: Север\r\nX-Injected: true",
      "analytics",
      { from: "2026-08-01", to: "2026-08-31" },
      "xlsx",
    );
    expect(filename).toBe("ООО-Право-СеверX-Injected-true-analytics-2026-08-01-2026-08-31.xlsx");
    expect(filename).not.toMatch(/[\\/:\r\n]/u);
    const disposition = projectExportContentDisposition(filename);
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+"; filename\*=UTF-8''/u);
    expect(disposition).toContain("%D0%9E%D0%9E%D0%9E");
    expect(disposition).not.toMatch(/[\r\n]/u);
  });
});
