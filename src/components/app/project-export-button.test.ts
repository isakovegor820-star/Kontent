import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type {
  ClientProjectExportOperation,
  ClientProjectExportPreview,
} from "@/lib/project-export-client";
import {
  calendarProjectExportPeriod,
  channelProjectExportValue,
  ProjectExportOperationPanel,
  ProjectExportPreviewPanel,
} from "./project-export-button";

const readyOperation: ClientProjectExportOperation = {
  id: 71,
  kind: "analytics",
  format: "pdf",
  status: "ready",
  filters: {
    period: { from: "2026-08-01", to: "2026-08-11" },
    channel: [],
    author: [],
    campaign: [],
    status: ["Подтверждено"],
  },
  errorCode: null,
  errorMessage: null,
  createdAt: "2026-08-11T10:00:00.000Z",
  updatedAt: "2026-08-11T10:00:02.000Z",
  completedAt: "2026-08-11T10:00:02.000Z",
  artifact: {
    byteSize: 3072,
    fileName: "ТехнологИИ-Права-аналитика.pdf",
    mimeType: "application/pdf",
    expiresAt: "2099-08-12T10:00:00.000Z",
  },
};

const preview: ClientProjectExportPreview = {
  kind: "content_plan",
  timezone: "Europe/Amsterdam",
  period: { from: "2026-08-01", to: "2026-08-31" },
  filters: { channel: [], author: [], campaign: [], status: [] },
  rowCount: 12,
  exceedsLimit: false,
  previewHash: "a".repeat(64),
  sample: [{
    id: "51",
    occurredAt: "2026-08-11T10:00:00.000Z",
    channel: "ТехнологИИ Права",
    title: "Длинная юридическая тема, которую нужно увидеть до формирования файла",
    status: "Запланирован",
    author: "Ирина",
    campaign: "Практика банкротства",
  }],
};

describe("project export interface", () => {
  it("renders a confirmed ready state with explicit download and revocation actions", () => {
    const html = renderToStaticMarkup(createElement(ProjectExportOperationPanel, {
      operation: readyOperation,
      revoked: false,
      busy: null,
      onDownload: vi.fn(),
      onRefresh: vi.fn(),
      onRetry: vi.fn(),
      onRevoke: vi.fn(),
    }));
    expect(html).toContain("Файл готов");
    expect(html).toContain("ТехнологИИ-Права-аналитика.pdf");
    expect(html).toContain("Скачать файл");
    expect(html).toContain("Отозвать файл");
    expect(html).not.toContain("Скачать успешно");
  });

  it("distinguishes background preparation from success", () => {
    const html = renderToStaticMarkup(createElement(ProjectExportOperationPanel, {
      operation: { ...readyOperation, status: "queued", artifact: null, completedAt: null },
      revoked: false,
      busy: null,
      onDownload: vi.fn(),
      onRefresh: vi.fn(),
      onRetry: vi.fn(),
      onRevoke: vi.fn(),
    }));
    expect(html).toContain("Файл готовится в фоне");
    expect(html).toContain("Проверить статус");
    expect(html).not.toContain("Скачать файл");
    expect(html).toContain("motion-reduce:animate-none");
  });

  it("shows the server count and sample before the export action", () => {
    const html = renderToStaticMarkup(createElement(ProjectExportPreviewPanel, {
      preview,
      refreshing: false,
      onRefresh: vi.fn(),
    }));
    expect(html).toContain("Предварительная выборка");
    expect(html).toContain("Найдено строк: 12");
    expect(html).toContain("Длинная юридическая тема");
    expect(html).toContain("ТехнологИИ Права");
    expect(html).toContain("Обновить выборку");
    expect(html).toMatch(/<section[^>]+aria-labelledby=/u);
  });

  it("uses the visible calendar range and exact server channel label", () => {
    expect(calendarProjectExportPeriod(
      "week",
      new Date(2026, 7, 6),
      new Date(2026, 7, 3),
    )).toEqual({ from: "2026-08-03", to: "2026-08-09" });
    expect(calendarProjectExportPeriod(
      "month",
      new Date(2026, 7, 6),
      new Date(2026, 7, 3),
    )).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(channelProjectExportValue({
      id: 4,
      network: "tg",
      title: null,
      handle: "@techlaw",
      is_active: true,
    })).toBe("@techlaw");
  });

  it("keeps the dialog, forms and status flow accessible and reflow-safe", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/components/app/project-export-button.tsx"),
      "utf8",
    );
    expect(source).toContain("<dialog");
    expect(source).toContain("showModal()");
    expect(source).toContain('aria-haspopup="dialog"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("previewProjectExport(value)");
    expect(source).toContain('"Проверить выборку"');
    expect(source).toContain('"Сформировать файл"');
    expect(source).toContain("<fieldset");
    expect(source).toContain("<legend");
    expect(source).toContain('type="date"');
    expect(source).toContain("min-h-11");
    expect(source).toContain("calc(100%-2rem)");
    expect(source).toContain("overscroll-contain");
    expect(source).toContain("focus-visible:ring-4");
    expect(source).not.toContain("transition-all");
    expect(source).not.toMatch(/body:\s*JSON\.stringify\([^)]*projectId/u);
  });

  it("is integrated into both real screens with the correct default dataset", () => {
    const calendar = fs.readFileSync(path.join(process.cwd(), "src/app/app/calendar/page.tsx"), "utf8");
    const analytics = fs.readFileSync(path.join(process.cwd(), "src/app/app/analytics/page.tsx"), "utf8");
    expect(calendar).toContain("<ProjectExportButton");
    expect(calendar).toContain('defaultKind="content_plan"');
    expect(calendar).toContain("initialPeriod={exportPeriod}");
    expect(analytics).toContain("<ProjectExportButton");
    expect(analytics).toContain('defaultKind="analytics"');
    expect(analytics).toContain("initialChannelId={channelId}");
  });
});
