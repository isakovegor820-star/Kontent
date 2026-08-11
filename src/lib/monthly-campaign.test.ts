import { describe, expect, it } from "vitest";

import {
  findCampaignDuplicates,
  isMonthlyCampaignStale,
  materializeFirstCampaignWeek,
  monthlyCampaignBriefHash,
  moveCampaignItem,
  replaceOneCampaignItem,
  titleSimilarity,
  validateMonthlyCampaignBrief,
  type MonthlyCampaignBrief,
  type MonthlyCampaignItem,
} from "./monthly-campaign";

const brief: MonthlyCampaignBrief = {
  goal: "Получить обращения по сопровождению бизнеса",
  startsOn: "2026-09-01",
  endsOn: "2026-09-30",
  timezone: "Europe/Moscow",
  rubrics: ["Практика", "Изменения", "Ошибки бизнеса"],
  practices: ["Корпоративное право", "Суды"],
  audience: "Собственники малого и среднего бизнеса",
  funnelStages: ["awareness", "consideration", "consultation"],
  postsPerWeek: 5,
  importantDates: [{ date: "2026-09-15", label: "Отчётность" }],
  ctas: ["Записаться на консультацию"],
  metrics: ["Подтверждённые заявки"],
  profileVersion: 3,
  contentBriefVersion: 8,
};

function items(count = 30): MonthlyCampaignItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index + 1}`,
    scheduledFor: `2026-09-${String(index + 1).padStart(2, "0")}`,
    position: index,
    title: `Тема ${index + 1}: право бизнеса`,
    rubric: brief.rubrics[index % brief.rubrics.length],
    practice: brief.practices[index % brief.practices.length],
    funnelStage: brief.funnelStages[index % brief.funnelStages.length],
    state: "topic",
    approvedRevision: null,
    sourceItemId: null,
    weeklyItemId: null,
    draftId: null,
    postId: null,
  }));
}

describe("monthly campaign domain", () => {
  it("validates a full month and creates a stable stale-plan fingerprint", () => {
    expect(validateMonthlyCampaignBrief(brief)).toEqual([]);
    const hash = monthlyCampaignBriefHash(brief);
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(monthlyCampaignBriefHash({ ...brief, rubrics: [...brief.rubrics] })).toBe(hash);
    expect(isMonthlyCampaignStale({
      snapshotBriefHash: hash,
      snapshotProfileVersion: 3,
      snapshotContentBriefVersion: 8,
      currentBrief: brief,
    })).toBe(false);
    expect(isMonthlyCampaignStale({
      snapshotBriefHash: hash,
      snapshotProfileVersion: 3,
      snapshotContentBriefVersion: 8,
      currentBrief: { ...brief, audience: "Юристы компаний" },
    })).toBe(true);
  });

  it("rejects incomplete campaign briefs instead of inventing defaults", () => {
    expect(validateMonthlyCampaignBrief({
      ...brief,
      startsOn: "2026-09-20",
      endsOn: "2026-09-01",
      rubrics: ["Практика"],
      practices: [],
      postsPerWeek: 0,
    })).toEqual(expect.arrayContaining([
      "invalid_period",
      "rubrics_3_to_6",
      "practices_required",
      "invalid_frequency",
    ]));
  });

  it("details only the nearest seven dates", () => {
    const result = materializeFirstCampaignWeek(items());
    expect(result.filter((item) => item.state === "detailed").map((item) => item.id)).toEqual(
      ["item-1", "item-2", "item-3", "item-4", "item-5", "item-6", "item-7"],
    );
    expect(result.slice(7).every((item) => item.state === "topic")).toBe(true);
  });

  it("moves one item with the same result for keyboard and drag/drop callers", () => {
    const original = items();
    const moved = moveCampaignItem(original, "item-3", "earlier");
    expect(moved.slice(0, 4).map((item) => item.id)).toEqual(["item-1", "item-3", "item-2", "item-4"]);
    expect(moved[1].scheduledFor).toBe("2026-09-02");
    expect(moved[2].scheduledFor).toBe("2026-09-03");
    expect(original[1].id).toBe("item-2");
  });

  it("regenerates only one unapproved topic", () => {
    const original = items();
    const changed = replaceOneCampaignItem(original, "item-12", {
      title: "Как проверить полномочия директора",
      rubric: "Практика",
      practice: "Корпоративное право",
      funnelStage: "consideration",
    });
    expect(changed[11].title).toBe("Как проверить полномочия директора");
    expect(changed.filter((item, index) => item !== original[index])).toHaveLength(1);
    expect(() => replaceOneCampaignItem(
      original.map((item) => item.id === "item-12" ? { ...item, state: "approved" } : item),
      "item-12",
      { title: "Новая", rubric: "Практика", practice: "Суды", funnelStage: "awareness" },
    )).toThrow("approved_item_requires_new_plan_revision");
  });

  it("finds semantic duplicates across library and old plans", () => {
    expect(titleSimilarity("Пять ошибок директора при банкротстве", "5 ошибок директора в банкротстве"))
      .toBeGreaterThan(0.72);
    expect(findCampaignDuplicates("Пять ошибок директора при банкротстве", [
      { id: "lib-1", title: "5 ошибок директора в банкротстве", source: "library" },
      { id: "old-1", title: "Новый порядок регистрации ООО", source: "past_plan" },
    ])).toEqual([expect.objectContaining({ id: "lib-1", source: "library" })]);
  });
});
