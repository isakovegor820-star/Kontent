import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import {
  libraryPdfItemLines,
  LIBRARY_EXPORT_FORMATS,
  renderLibraryExport,
  renderTabularXlsx,
  resolveLibraryPdfFontPath,
} from "./library-export.mjs";

const snapshot = {
  exportedAt: "2026-08-05T10:00:00.000Z",
  activeFilters: { q: "право", scoreMin: 60 },
  formulaVersion: "aurora-library-v1",
  items: [{
    kind: "reference",
    text: "=Гиперссылка и кириллица",
    channelTitle: "Аврора",
    sourceTitle: "Источник",
    sourceUrl: "https://example.test/post/1",
    sourceData: "public_telegram",
    postedAt: "2026-08-04T10:00:00.000Z",
    views: 1200,
    reactions: 80,
    lift: 5.2,
    erBayes: 0.06,
    velocity: 50,
    velocityZ: 1.4,
    freshness: 0.9,
    analyticsScore: 87,
    userRating: 4,
    dataQuality: "high",
    dataMaturity: "mature",
    formulaVersion: "aurora-library-v1",
  }],
};

describe("library snapshot exports", () => {
  it("resolves the Unicode PDF font without exposing a static TTF module to Turbopack", async () => {
    expect(resolveLibraryPdfFontPath()).toMatch(/Geist-Regular\.ttf$/u);
    const fallback = resolveLibraryPdfFontPath({
      cwd: "/srv/aurora",
      moduleResolve: () => "/opt/node_modules/next/package.json",
      exists: (path) => path === "/opt/node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf",
    });
    expect(fallback).toBe("/opt/node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf");

    const source = await readFile(new URL("./library-export.mjs", import.meta.url), "utf8");
    expect(source).not.toMatch(/require\.resolve\(["']next\/dist\/compiled\/[^"']+\.ttf["']\)/u);
  });

  it("renders all six formats from one immutable snapshot", async () => {
    expect(LIBRARY_EXPORT_FORMATS).toHaveLength(6);
    const rendered = Object.fromEntries(
      await Promise.all(LIBRARY_EXPORT_FORMATS.map(async (format) => [format, await renderLibraryExport(format, snapshot)])),
    );
    expect(rendered.csv.bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(rendered.csv.bytes.toString("utf8")).toContain("'=Гиперссылка");
    expect(rendered.xlsx.bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(JSON.parse(rendered.json.bytes.toString("utf8"))).toMatchObject({ activeFilters: snapshot.activeFilters });
    expect(rendered.pdf.bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(rendered.html.bytes.toString("utf8")).toContain("Дата экспорта");
    expect(rendered.markdown.bytes.toString("utf8")).toContain("Версия формулы");
  });

  it("escapes executable spreadsheet strings and HTML", async () => {
    const csv = await renderLibraryExport("csv", snapshot);
    expect(csv.bytes.toString("utf8")).not.toContain('"=Гиперссылка');
    const html = await renderLibraryExport("html", {
      ...snapshot,
      items: [{ ...snapshot.items[0], text: "<script>alert(1)</script>" }],
    });
    expect(html.bytes.toString("utf8")).not.toContain("<script>alert");
    expect(html.bytes.toString("utf8")).toContain("&lt;script&gt;");
  });

  it("includes provenance plus every original and computed metric in PDF rows", () => {
    const lines = libraryPdfItemLines(snapshot.items[0]).join("\n");
    for (const label of [
      "Источник данных:", "Дата публикации:", "Просмотры:", "Реакции:",
      "Прирост:", "Скорректированная вовлечённость:", "Скорость:", "Отклонение скорости:", "Свежесть:",
      "Оценка 0–100:", "Оценка 1–5:", "Качество данных:",
      "Зрелость данных:", "Версия формулы:", "Оригинал:",
    ]) expect(lines).toContain(label);
  });

  it("creates a usable XLSX table with typed dates, widths, a frozen header and filters", () => {
    const bytes = renderTabularXlsx([
      ["Дата", "Заявки", "Формула"],
      [new Date("2026-08-11T09:30:00.000Z"), 3, "=2+2"],
    ], "Аналитика", { headerRow: 1 });
    expect(bytes.includes(Buffer.from('<pane ySplit="1"'))).toBe(true);
    expect(bytes.includes(Buffer.from('<autoFilter ref="A1:C2"'))).toBe(true);
    expect(bytes.includes(Buffer.from('customWidth="1"'))).toBe(true);
    expect(bytes.includes(Buffer.from('s="1"><v>'))).toBe(true);
    expect(bytes.includes(Buffer.from("'=2+2"))).toBe(true);
    expect(bytes.includes(Buffer.from('formatCode="yyyy-mm-dd hh:mm"'))).toBe(true);
  });
});
