import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dashboard = readFileSync(new URL("./admin-dashboard.tsx", import.meta.url), "utf8");
const system = readFileSync(new URL("./admin-system-center.tsx", import.meta.url), "utf8");
const analytics = readFileSync(new URL("./admin-aurora-analytics.tsx", import.meta.url), "utf8");
const analyticsServer = readFileSync(new URL("../../lib/admin-aurora-analytics.ts", import.meta.url), "utf8");

describe("admin operations center interface contract", () => {
  it("keeps infrastructure and product analytics as separate CRM destinations", () => {
    expect(dashboard).toContain('id: "system"');
    expect(dashboard).toContain('id: "aurora-analytics"');
    expect(dashboard).toContain('label: "Аналитика Авроры"');
    expect(dashboard).toContain('<AdminSystemCenter />');
    expect(dashboard).toContain('<AdminAuroraAnalyticsCenter />');
  });

  it("uses an in-page system detail with reproducible URL/history and refresh controls", () => {
    expect(system).toContain('window.history.pushState({}, "", adminSystemHref');
    expect(system).toContain('window.addEventListener("popstate", syncSelection)');
    expect(system).toContain('id="system-component-detail"');
    expect(system).toContain('scrollIntoView({ behavior: "smooth", block: "start" })');
    expect(system).toContain('<option value={30_000}>30 секунд</option>');
    expect(system).toContain('<option value={60_000}>1 минута</option>');
    expect(system).not.toMatch(/\b(?:dialog|modal)\b/iu);
  });

  it("exposes all required analytics dimensions and five URL-backed detail tabs", () => {
    for (const label of ["Проект", "Сегмент", "Пользователи", "Устройство", "Версия", "Релиз"]) {
      expect(analytics).toContain(`>${label}<select`);
    }
    for (const tab of ["Обзор", "Воронка", "Ошибки", "Скорость", "События"]) {
      expect(analytics).toContain(`label: "${tab}"`);
    }
    expect(analytics).toContain('window.addEventListener("popstate", syncUrl)');
    expect(analytics).toContain('window.history.pushState({}, "", href)');
    expect(analytics).toContain('aria-labelledby="aurora-sections-title"');
    expect(analytics).toContain('Время до результата · p50');
    expect(analytics).toContain('label="p99"');
  });

  it("keeps correlation and cross-navigation safe and operational", () => {
    expect(analytics).toContain("Копировать request ID");
    expect(analytics).toContain("Открыть зависимость");
    expect(analytics).toContain("Открыть в Sentry");
    expect(system).toContain("Затронутые разделы");
    expect(analyticsServer).toContain("affectedUsers * frequency * severity");
    expect(analyticsServer).toContain('kind: "stuck_stage"');
  });

  it("contains no demo generators, fixtures or fabricated metric fallback", () => {
    const productionSources = `${system}\n${analytics}\n${analyticsServer}`;
    expect(productionSources).not.toContain("Math.random");
    expect(productionSources).not.toMatch(/\b(?:demoData|mockData|fixtureData|sampleMetrics|fakeStatus)\b/u);
    expect(analytics).toContain("Пустой период остаётся пустым");
    expect(analytics).toContain("данные не подменяются оценками");
  });
});
