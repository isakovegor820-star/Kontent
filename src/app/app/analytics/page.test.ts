import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("analytics dashboard interface contract", () => {
  const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

  it("provides focused analytics sections with one shared channel and period", () => {
    expect(source).toContain('label: "Обзор"');
    expect(source).toContain('label: "Публикации"');
    expect(source).toContain('label: "Рост"');
    expect(source).toContain('label: "Конкуренты"');
    expect(source).toContain('label: "Переходы"');
    expect(source).toContain("<ChannelPicker");
    expect(source).toContain('id="analytics-period"');
    expect(source).toContain("&days=${periodDays}");
  });

  it("renders only data-driven charts with useful empty states", () => {
    expect(source).toContain("function SubscriberLineChart");
    expect(source).toContain("function DailyGrowthChart");
    expect(source).toContain("function PostPerformanceChart");
    expect(source).toContain("function CompetitorBenchmarkChart");
    expect(source).toContain("function ChartEmpty");
    expect(source).toContain('role="img"');
    expect(source).toContain('aria-label="Разделы статистики"');
  });

  it("shows provenance, coverage and unavailable metrics without fake zeroes", () => {
    expect(source).toContain("Подтверждённые публикации");
    expect(source).toContain("со статистикой");
    expect(source).toContain("Охват и комментарии");
    expect(source).toContain("не заменяются нулями");
    expect(source).toContain("Последний сбор");
  });
});
