import { describe, expect, it } from "vitest";

import {
  campaignEditorialWeeks,
  campaignMonthRange,
  campaignMonthTitle,
  equalPracticeMix,
  monthCalendarCells,
  monthlyCampaignStudioPrompt,
  monthlyCampaignWorkflowStep,
  parseMonthlyCampaignDetail,
  parseMonthlyCampaignList,
  type MonthlyCampaignClientItem,
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
      regenerations: [{
        id: 9,
        planId: 5,
        scope: "month",
        weekStartsOn: null,
        status: "pending",
        targetItemIds: [7],
        errorCode: null,
      }],
    })).toMatchObject({ plans: [{ items: [{ id: 7 }] }], regenerations: [{ scope: "month" }] });
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

  it("titles the month in Russian and groups the editorial weeks used by regeneration", () => {
    expect(campaignMonthTitle("2026-09-01")).toBe("Сентябрь 2026");
    const item = (day: string, id: number): MonthlyCampaignClientItem => ({
      id,
      itemKey: `day-${day}`,
      scheduledFor: day,
      position: id,
      title: `Тема ${id}`,
      rubric: "Практика",
      practice: "Суды",
      funnelStage: "awareness",
      state: "topic",
      approvalStatus: "draft",
      draftId: id === 1 ? 9 : null,
      postId: null,
      weeklyAutopilotPlanId: null,
      regenerationStatus: "idle",
    });
    const days = [
      "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04",
      "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08",
    ];
    const weeks = campaignEditorialWeeks(days.map((day, index) => item(day, index + 1)));
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toMatchObject({ index: 1, startsOn: "2026-09-01", endsOn: "2026-09-07" });
    expect(weeks[1]).toMatchObject({ index: 2, startsOn: "2026-09-08", endsOn: "2026-09-08" });
    expect(monthCalendarCells("2026-09-01", "2026-09-30")[0]).toBeNull();
    expect(monthCalendarCells("2026-09-01", "2026-09-30")[1]).toBe("2026-09-01");
    expect(monthCalendarCells("2026-09-01", "2026-09-30")).toHaveLength(35);
    expect(monthlyCampaignWorkflowStep(null)).toBe(1);
    expect(monthlyCampaignWorkflowStep({
      id: 5, revision: 1, status: "in_review", version: 3, stale: false, items: [],
    })).toBe(2);
    expect(monthlyCampaignWorkflowStep({
      id: 5, revision: 1, status: "approved", version: 3, stale: false, items: [],
    })).toBe(3);
  });

  it("builds a studio write prompt from the campaign topic without putting it in a URL", () => {
    expect(monthlyCampaignStudioPrompt({
      title: "Что проверить до подписания",
      rubric: "Практика",
      practice: "Суды",
      audience: "Собственники бизнеса",
      goal: "Привести к консультации",
      cta: "Обсудить задачу",
    })).toContain("Что проверить до подписания");
    expect(monthlyCampaignStudioPrompt({
      title: "Тема",
      rubric: "Практика",
      practice: "Суды",
      audience: "Собственники",
      goal: "Цель",
    })).toContain("Не выдумывай законы");
  });
});
