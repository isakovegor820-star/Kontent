import { describe, expect, it } from "vitest";

import {
  campaignMonthRange,
  equalPracticeMix,
  parseMonthlyCampaignDetail,
  parseMonthlyCampaignList,
} from "./monthly-campaign-client";

const campaign = {
  id: 41,
  goal: "Системно раскрывать практику",
  startsOn: "2026-09-01",
  endsOn: "2026-09-30",
  timezone: "Europe/Moscow",
  rubrics: ["Практика", "Ошибки", "Вопросы"],
  practiceMix: [{ name: "Суды", kind: "practice", weight: 100 }],
  audience: "Собственники бизнеса",
  funnelStages: ["awareness"],
  postsPerWeek: 5,
  importantDates: [],
  ctas: ["Обсудить задачу"],
  metrics: ["Подтверждённые обращения"],
  version: 2,
  updatedAt: "2026-08-15T10:00:00.000Z",
};

describe("monthly campaign client contract", () => {
  it("parses strict project campaign responses and rejects incomplete items", () => {
    expect(parseMonthlyCampaignList({ ok: true, campaigns: [campaign] })).toEqual([campaign]);
    expect(parseMonthlyCampaignDetail({
      ok: true,
      campaign,
      plans: [{
        id: 5,
        revision: 1,
        status: "draft",
        version: 3,
        stale: false,
        items: [{
          id: 7,
          itemKey: "day-2026-09-01",
          scheduledFor: "2026-09-01",
          position: 0,
          title: "Что проверить до подписания",
          rubric: "Практика",
          practice: "Суды",
          funnelStage: "awareness",
          state: "detailed",
          approvalStatus: "draft",
          draftId: null,
          postId: null,
          weeklyAutopilotPlanId: null,
          regenerationStatus: "idle",
        }],
      }],
      regenerations: [],
    })).toMatchObject({ plans: [{ items: [{ id: 7 }] }] });
    expect(parseMonthlyCampaignDetail({ ok: true, campaign, plans: [{ id: 5, items: [{}] }], regenerations: [] }))
      .toBeNull();
  });

  it("keeps calendar order after dates and positions are swapped", () => {
    const item = (id: number, scheduledFor: string, position: number) => ({
      id,
      itemKey: `item-${id}`,
      scheduledFor,
      position,
      title: `Тема ${id}`,
      rubric: "Практика",
      practice: "Суды",
      funnelStage: "awareness",
      state: "topic",
      approvalStatus: "draft",
      draftId: null,
      postId: null,
      weeklyAutopilotPlanId: null,
      regenerationStatus: "idle",
    });
    const detail = parseMonthlyCampaignDetail({
      ok: true,
      campaign,
      plans: [{
        id: 5,
        revision: 1,
        status: "draft",
        version: 4,
        stale: false,
        items: [
          item(1, "2026-09-02", 1),
          item(2, "2026-09-01", 0),
        ],
      }],
      regenerations: [],
    });

    expect(detail?.plans[0].items.map((entry) => entry.id)).toEqual([2, 1]);
  });

  it("derives the exact calendar month and balanced weights", () => {
    expect(campaignMonthRange("2028-02")).toEqual({ startsOn: "2028-02-01", endsOn: "2028-02-29" });
    expect(equalPracticeMix(["Суды", "Договоры", "Налоги"])).toEqual([
      { name: "Суды", kind: "practice", weight: 34 },
      { name: "Договоры", kind: "practice", weight: 33 },
      { name: "Налоги", kind: "practice", weight: 33 },
    ]);
  });
});
