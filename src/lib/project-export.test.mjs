import { describe, expect, it } from "vitest";

import {
  projectExportFilename,
  renderProjectExport,
} from "./project-export.mjs";

const snapshot = {
  kind: "analytics",
  exportedAt: "2026-08-11T10:00:00.000Z",
  project: { id: 7, name: "ТехнологИИ Права", timezone: "Europe/Moscow" },
  period: { from: "2026-08-01", to: "2026-08-31" },
  filters: { channel: "Telegram", campaign: "Банкротство" },
  methodology: "Уникальный клик — один fingerprint за 24 часа. Конверсии учитываются по идемпотентному событию.",
  rows: [{
    publishedAt: "2026-08-10T09:30:00.000Z",
    channel: "Telegram",
    campaign: "Банкротство",
    title: "=Пять действий директора",
    status: "Подтверждено площадкой",
    views: 1250,
    reactions: 84,
    comments: 12,
    shares: 7,
    clicksTotal: 31,
    clicksUnique: 24,
    conversions: 3,
    trackerState: "Подключён",
    postUrl: "https://t.me/example/42",
  }],
};

describe("project CSV/XLSX/PDF exports", () => {
  it("renders one immutable selection in all formats with Cyrillic and safe formulas", async () => {
    const [csv, xlsx, pdf] = await Promise.all([
      renderProjectExport("csv", snapshot),
      renderProjectExport("xlsx", snapshot),
      renderProjectExport("pdf", snapshot),
    ]);
    expect(csv.bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(csv.bytes.toString("utf8")).toContain("ТехнологИИ Права");
    expect(csv.bytes.toString("utf8")).toContain("'=Пять действий директора");
    expect(xlsx.bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    expect(xlsx.bytes.includes(Buffer.from("ТехнологИИ Права"))).toBe(true);
    expect(xlsx.bytes.includes(Buffer.from('<autoFilter ref="A8:N9"'))).toBe(true);
    expect(xlsx.bytes.includes(Buffer.from('s="1"><v>'))).toBe(true);
    expect(xlsx.bytes.includes(Buffer.from("'=Пять действий директора"))).toBe(true);
    expect(pdf.bytes.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("returns valid empty reports rather than a server error", async () => {
    const empty = { ...snapshot, rows: [] };
    for (const format of ["csv", "xlsx", "pdf"]) {
      await expect(renderProjectExport(format, empty)).resolves.toMatchObject({ extension: format });
    }
  });

  it("builds bounded filenames without path separators", () => {
    expect(projectExportFilename("ООО / Право: Север", "analytics", snapshot.period, "xlsx"))
      .toBe("ООО-Право-Север-analytics-2026-08-01-2026-08-31.xlsx");
  });
});
