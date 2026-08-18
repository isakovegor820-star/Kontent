import { describe, expect, it } from "vitest";

import { buildTodayView, type TodaySnapshot } from "./today";

const EMPTY: TodaySnapshot = {
  drafts: [],
  audience: { inquiries: [], stats: { waiting: 0, ready: 0, highRisk: 0 } },
  questions: [],
  rssUnreadCount: 0,
};

describe("today view", () => {
  it("keeps the three highest-value real actions in priority order", () => {
    const view = buildTodayView({
      drafts: [
        {
          id: 41,
          text: "Пост с замечаниями",
          purpose: "publishable",
          editorial_state: "changes_requested",
          scheduled_at: null,
          updated_at: "2026-08-18T09:00:00.000Z",
        },
        {
          id: 42,
          text: "Готовый черновик",
          purpose: "publishable",
          editorial_state: "draft",
          scheduled_at: null,
          updated_at: "2026-08-18T10:00:00.000Z",
        },
      ],
      audience: {
        stats: { waiting: 2, ready: 1, highRisk: 1 },
        inquiries: [
          {
            id: 51,
            authorName: "Мария",
            incomingText: "Сложный вопрос",
            status: "pending",
            riskLevel: "high",
            createdAt: "2026-08-18T08:00:00.000Z",
          },
          {
            id: 52,
            authorName: null,
            incomingText: "Обычный вопрос",
            status: "reply_ready",
            riskLevel: "low",
            createdAt: "2026-08-18T07:00:00.000Z",
          },
        ],
      },
      questions: [{
        id: 61,
        question: "Как зарегистрировать товарный знак?",
        priority: 3,
        occurrences: 4,
        status: "new",
        updatedAt: "2026-08-18T06:00:00.000Z",
      }],
      rssUnreadCount: 8,
    });

    expect(view.tasks.map((task) => task.kind)).toEqual([
      "changes_requested",
      "high_risk_reply",
      "ready_reply",
    ]);
    expect(view.tasks[0]?.href).toBe("/app/composer?draft=41");
    expect(view.tasks[1]?.href).toBe("/app/studio/questions?inquiry=51");
  });

  it("does not invent work for an empty project", () => {
    const view = buildTodayView(EMPTY);

    expect(view.tasks).toEqual([]);
    expect(view.metrics.map((metric) => metric.value)).toEqual([0, 0, 0]);
  });

  it("uses demand and unscheduled drafts as useful fallbacks", () => {
    const view = buildTodayView({
      ...EMPTY,
      drafts: [{
        id: 7,
        text: "  Черновик   с   лишними пробелами  ",
        purpose: "publishable",
        editorial_state: "approved",
        scheduled_at: null,
        updated_at: "2026-08-18T10:00:00.000Z",
      }],
      questions: [{
        id: 8,
        question: "Что писать в договоре?",
        priority: 2,
        occurrences: 3,
        status: "new",
        updatedAt: "2026-08-18T11:00:00.000Z",
      }],
      rssUnreadCount: 2,
    });

    expect(view.tasks.map((task) => task.kind)).toEqual([
      "audience_question",
      "unscheduled_draft",
      "rss",
    ]);
    expect(view.tasks[0]?.description).toContain("3 раза");
    expect(view.tasks[1]?.description).toContain("Черновик с лишними пробелами");
  });

  it("shows unavailable source metrics honestly", () => {
    const view = buildTodayView({
      drafts: null,
      audience: null,
      questions: null,
      rssUnreadCount: null,
    });

    expect(view.tasks).toEqual([]);
    expect(view.metrics.map((metric) => metric.value)).toEqual([null, null, null]);
  });
});
