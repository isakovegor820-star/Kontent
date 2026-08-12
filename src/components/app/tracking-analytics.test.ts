import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  filterTrackingRows,
  groupTrackingRows,
  parseTrackingReport,
  TrackingAnalyticsView,
  trackingPeriod,
  type TrackingReport,
} from "./tracking-analytics";

const report: TrackingReport = {
  period: { from: "2026-07-12T10:00:00.000Z", to: "2026-08-11T10:00:00.000Z" },
  tracker: {
    status: "not_connected",
    siteOrigin: null,
    publicKey: null,
    attributionWindowDays: 30,
    version: 0,
    verifiedAt: null,
    lastPingAt: null,
  },
  methodology: {
    totalClicks: "Переходы без очевидных ботов; каждый запрос считается отдельно.",
    uniqueClicks: "Первый переход одного обезличенного браузера по ссылке за календарные сутки UTC.",
    conversions: "Только события с действующей подписанной атрибуцией и уникальным ключом события.",
    postAttribution: "Каждая публикация получает отдельный непрозрачный адрес.",
  },
  rows: [
    {
      linkId: 7,
      slug: "abcdefghijklmnopqrstuvwxyz123456",
      campaign: "Практика банкротства",
      source: "telegram",
      medium: "social",
      postId: 31,
      channelId: 4,
      channelTitle: "ТехнологИИ Права",
      totalClicks: 5,
      uniqueClicks: 4,
      confirmedConversions: 1,
      formOpens: 0,
      formSubmits: 0,
      consultations: 0,
    },
    {
      linkId: 7,
      slug: "abcdefghijklmnopqrstuvwxyz123456",
      campaign: "Практика банкротства",
      source: "telegram",
      medium: "social",
      postId: 32,
      channelId: 4,
      channelTitle: "ТехнологИИ Права",
      totalClicks: 12,
      uniqueClicks: 8,
      confirmedConversions: 0,
      formOpens: 0,
      formSubmits: 0,
      consultations: 0,
    },
  ],
};

describe("tracking analytics client contract", () => {
  it("accepts a complete server report and rejects invented or malformed metrics", () => {
    expect(parseTrackingReport({ ok: true, report })).toEqual(report);
    expect(parseTrackingReport({
      ok: true,
      report: { ...report, rows: [{ ...report.rows[0], totalClicks: "12" }] },
    })).toBeNull();
    expect(parseTrackingReport({
      ok: true,
      report: { ...report, tracker: { ...report.tracker, status: "connected-ish" } },
    })).toBeNull();
  });

  it("sums mutually exclusive placement scopes without duplicating one click across posts", () => {
    const grouped = groupTrackingRows(report.rows);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({
      totalClicks: 17,
      uniqueClicks: 12,
      confirmedConversions: 1,
      posts: ["Публикация №31", "Публикация №32"],
    });
    expect(filterTrackingRows(report.rows, {
      campaign: `campaign:${encodeURIComponent("Практика банкротства")}`,
      channel: "channel:4",
      post: "post:32",
    })).toHaveLength(1);
  });

  it("keeps distinct publication addresses in separate analytics rows", () => {
    const grouped = groupTrackingRows([
      report.rows[0],
      { ...report.rows[1], slug: "separateplacementaddress123" },
    ]);
    expect(grouped).toHaveLength(2);
    expect(grouped.map((row) => row.slug)).toEqual([
      "abcdefghijklmnopqrstuvwxyz123456",
      "separateplacementaddress123",
    ]);
    expect(grouped.map((row) => row.totalClicks)).toEqual([5, 12]);
  });

  it("builds an exact, deterministic UTC query period", () => {
    expect(trackingPeriod(7, new Date("2026-08-11T10:00:00.000Z"))).toEqual({
      from: "2026-08-04T10:00:00.000Z",
      to: "2026-08-11T10:00:00.000Z",
    });
  });

  it("renders filters, a semantic funnel/table and the honest disconnected tracker state", () => {
    const html = renderToStaticMarkup(createElement(TrackingAnalyticsView, {
      projectName: "Очень длинное название юридической практики Северо-Западного офиса",
      report,
      loading: false,
      error: false,
      periodDays: 30,
      onPeriodChange: vi.fn(),
      onRetry: vi.fn(),
    }));
    expect(html).toContain("Трекер сайта не подключён");
    expect(html).toContain("не означает, что заявок на сайте не было");
    expect(html).toContain("Практика банкротства");
    expect(html).toContain("ТехнологИИ Права");
    expect(html).toContain("Публикация №31");
    expect(html).toContain("Публикация №32");
    expect(html).toContain("<fieldset");
    expect(html).toContain("<select");
    expect(html).toContain("<ol");
    expect(html).toContain("<table");
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('role="region"');
  });

  it("renders real zeros and a useful empty and retry state", () => {
    const emptyHtml = renderToStaticMarkup(createElement(TrackingAnalyticsView, {
      projectName: "ТехнологИИ Права",
      report: { ...report, tracker: { ...report.tracker, status: "active" }, rows: [] },
      loading: false,
      error: false,
      periodDays: 1,
      onPeriodChange: vi.fn(),
      onRetry: vi.fn(),
    }));
    expect(emptyHtml).toContain("Коротких ссылок пока нет");
    expect(emptyHtml).toContain("Нулевые значения сохранены без подмены данных");
    expect(emptyHtml).toContain(">0<");

    const errorHtml = renderToStaticMarkup(createElement(TrackingAnalyticsView, {
      projectName: "ТехнологИИ Права",
      report: null,
      loading: false,
      error: true,
      periodDays: 30,
      onPeriodChange: vi.fn(),
      onRetry: vi.fn(),
    }));
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain("Данные проекта не изменились");
    expect(errorHtml).toContain("Повторить загрузку");
  });

  it("keeps the implementation accessible and narrow-screen safe", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/components/app/tracking-analytics.tsx"), "utf8");
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("min-h-11");
    expect(source).toContain("overflow-x-auto");
    expect(source).toContain("tabular-nums");
    expect(source).toContain("text-pretty");
    expect(source).toContain("motion-reduce:transition-none");
    expect(source).toContain("current?.id");
    expect(source).toContain("key={requestKey");
    expect(source).not.toContain("transition-all");

    const pageSource = fs.readFileSync(path.join(process.cwd(), "src/app/app/analytics/page.tsx"), "utf8");
    expect(pageSource).toContain("<TrackingAnalyticsSection");
    expect(pageSource).toContain('aria-labelledby="channel-statistics-heading"');
  });
});
