import { describe, expect, it } from "vitest";

import { buildMonthlyCampaignSeedItems } from "./monthly-campaign-seed";

const campaign = {
  startsOn: "2026-09-01",
  endsOn: "2026-09-30",
  rubrics: ["Практика", "Ошибки", "Вопросы"],
  practiceMix: [
    { name: "Корпоративное право", kind: "practice" as const, weight: 60 },
    { name: "Судебная работа", kind: "service" as const, weight: 40 },
  ],
  funnelStages: ["awareness", "consideration", "consultation"] as const,
  importantDates: [{ date: "2026-09-15", label: "Внутренняя проверка" }],
  audience: "Собственники бизнеса",
};

describe("monthly campaign server seed", () => {
  it("creates one unique, fact-free topic per day and details only the nearest week", () => {
    const result = buildMonthlyCampaignSeedItems(campaign);
    expect(result).toHaveLength(30);
    expect(new Set(result.map((item) => item.itemKey)).size).toBe(30);
    expect(new Set(result.map((item) => item.scheduledFor)).size).toBe(30);
    expect(new Set(result.map((item) => item.title)).size).toBe(30);
    expect(result.slice(0, 7).every((item) => item.state === "detailed")).toBe(true);
    expect(result.slice(7).every((item) => item.state === "topic")).toBe(true);
    expect(result[14].title).toBe("Что проверить перед событием «Внутренняя проверка»");
    expect(result.some((item) => /ст\.\s*\d|№|\d{4}/iu.test(item.title))).toBe(false);
  });

  it("honours the weighted practice mix without requiring manual daily allocation", () => {
    const result = buildMonthlyCampaignSeedItems(campaign);
    expect(result.filter((item) => item.practice === "Корпоративное право")).toHaveLength(18);
    expect(result.filter((item) => item.practice === "Судебная работа")).toHaveLength(12);
  });
});
