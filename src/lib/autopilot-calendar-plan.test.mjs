import { describe, expect, it } from "vitest";

import {
  AUTOPILOT_CALENDAR_PLAN_LIMIT,
  autopilotPlanCalendarItems,
  autopilotPlanItemState,
} from "./autopilot-calendar-plan.mjs";
import { evaluateAutopilotItem } from "./autopilot-approval.mjs";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const FUTURE = "2026-10-08T14:00:00.000Z";
const PAST = "2026-10-04T14:00:00.000Z";

/** Quality proof that clears the automatic gate (см. post-quality.mjs). */
const verifiedQuality = () => ({
  score: 92,
  threshold: 85,
  passed: true,
  blockers: [],
  violations: [],
  publicationDisposition: "ready",
  metadata: {
    checkedAt: "2026-10-01T09:00:00.000Z",
    rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
    provenance: { kind: "deterministic", validator: "validatePostQuality", trigger: "generation" },
  },
  semantic: {
    version: 1,
    status: "passed",
    passed: true,
    requiresReview: false,
    claimVerdicts: [{ verdict: "supported", sourceSpans: [{ sourceId: "src-1", start: 0, end: 12 }] }],
    provenance: {
      validatorVersion: "semantic-publication-v1",
      checkedAt: "2026-10-01T09:00:00.000Z",
      terminalVerdict: "passed",
      provider: "navy",
    },
  },
});

const pendingItem = (overrides = {}) => ({
  i: 0,
  scheduledAt: FUTURE,
  topic: "Как вайб-кодинг экономит время",
  draft: "Текст публикации",
  status: "pending",
  quality: verifiedQuality(),
  ...overrides,
});

const plan = (overrides = {}) => ({
  id: 41,
  channel_id: 7,
  status: "pending",
  revision: 3,
  channel_title: "ТехнологИИ Права",
  items: [pendingItem()],
  ...overrides,
});

describe("autopilotPlanItemState", () => {
  it("отмечает готовый элемент как ожидающий подтверждения", () => {
    const item = pendingItem();
    const state = autopilotPlanItemState({
      item,
      evaluation: evaluateAutopilotItem(item, NOW, { actor: "human" }),
      planStatus: "pending",
    });
    expect(state.state).toBe("ready");
    expect(state.statusLabel).toBe("Не подтверждён");
    expect(state.selectable).toBe(true);
    expect(state.editable).toBe(true);
    expect(state.issues).toEqual([]);
  });

  it("просроченный элемент нельзя подтвердить, но он остаётся видимым", () => {
    const item = pendingItem({ scheduledAt: PAST });
    const state = autopilotPlanItemState({
      item,
      evaluation: evaluateAutopilotItem(item, NOW, { actor: "human" }),
      planStatus: "pending",
    });
    expect(state.state).toBe("expired");
    expect(state.statusLabel).toBe("Нужно новое время");
    expect(state.selectable).toBe(false);
    expect(state.issues.join(" ")).toContain("прошло");
  });

  it("элемент со статусом expired не подтверждается даже с датой в будущем", () => {
    const item = pendingItem({ status: "expired", approvalBlockers: [{ code: "expired", message: "Нужно новое время." }] });
    const state = autopilotPlanItemState({
      item,
      evaluation: evaluateAutopilotItem(item, NOW, { actor: "human" }),
      planStatus: "pending",
    });
    expect(state.state).toBe("expired");
    expect(state.selectable).toBe(false);
    expect(state.issues).toEqual(["Нужно новое время."]);
  });

  it("заблокированный по качеству элемент объясняет причину", () => {
    const item = pendingItem({ quality: { passed: false, blockers: ["Нет проверки фактов"], violations: [] } });
    const state = autopilotPlanItemState({
      item,
      evaluation: evaluateAutopilotItem(item, NOW, { actor: "human" }),
      planStatus: "pending",
    });
    expect(state.state).toBe("blocked");
    expect(state.statusLabel).toBe("Нужна проверка");
    expect(state.selectable).toBe(false);
    expect(state.issues.length).toBeGreaterThan(0);
  });

  it("подтверждение запрещено для не-pending плана (approval принимает только pending)", () => {
    const item = pendingItem();
    const state = autopilotPlanItemState({
      item,
      evaluation: evaluateAutopilotItem(item, NOW, { actor: "human" }),
      planStatus: "approved",
    });
    expect(state.state).toBe("ready");
    expect(state.selectable).toBe(false);
  });
});

describe("autopilotPlanCalendarItems", () => {
  it("проецирует план в карточки календаря с каналом и ревизией", () => {
    const [card] = autopilotPlanCalendarItems({
      plans: [plan()],
      nowMs: NOW,
      canPublish: true,
      canEdit: true,
    });
    expect(card).toMatchObject({
      key: "plan-41-0",
      planId: 41,
      planRevision: 3,
      index: 0,
      channelId: 7,
      channelTitle: "ТехнологИИ Права",
      scheduledAt: FUTURE,
      state: "ready",
      selectable: true,
      editable: true,
    });
  });

  it("не дублирует посты, которые уже стали публикацией", () => {
    const items = autopilotPlanCalendarItems({
      plans: [plan({ items: [pendingItem({ postId: 900, status: "approved" })] })],
      nowMs: NOW,
      canPublish: true,
      canEdit: true,
    });
    expect(items).toEqual([]);
  });

  it("скрывает уже отменённые и неактуальные статусы", () => {
    const items = autopilotPlanCalendarItems({
      plans: [plan({
        items: [
          pendingItem({ i: 0, status: "rejected" }),
          pendingItem({ i: 1, status: "published", postId: 12 }),
          pendingItem({ i: 2, status: "pending" }),
        ],
      })],
      nowMs: NOW,
      canPublish: true,
      canEdit: true,
    });
    expect(items.map((item) => item.index)).toEqual([2]);
  });

  it("без права публикации карточка видна, но добавить её нельзя", () => {
    const [card] = autopilotPlanCalendarItems({
      plans: [plan()],
      nowMs: NOW,
      canPublish: false,
      canEdit: false,
    });
    expect(card.state).toBe("ready");
    expect(card.selectable).toBe(false);
    expect(card.editable).toBe(false);
  });

  it("вырезает приватный след исследования из текста предпросмотра", () => {
    const [card] = autopilotPlanCalendarItems({
      plans: [plan({
        items: [pendingItem({ draft: "Полезный текст\n\nИсточник: https://internal.example/secret" })],
      })],
      nowMs: NOW,
      canPublish: true,
      canEdit: true,
    });
    expect(card.text).toBe("Полезный текст");
  });

  it("не показывает элементы без корректной даты", () => {
    const items = autopilotPlanCalendarItems({
      plans: [plan({ items: [pendingItem({ i: 0, scheduledAt: "не дата" }), pendingItem({ i: 1 })] })],
      nowMs: NOW,
      canPublish: true,
      canEdit: true,
    });
    expect(items.map((item) => item.index)).toEqual([1]);
  });

  it("сортирует карточки по времени публикации", () => {
    const items = autopilotPlanCalendarItems({
      plans: [plan({
        items: [
          pendingItem({ i: 2, scheduledAt: "2026-10-10T10:00:00.000Z" }),
          pendingItem({ i: 0, scheduledAt: "2026-10-06T10:00:00.000Z" }),
          pendingItem({ i: 1, scheduledAt: "2026-10-08T10:00:00.000Z" }),
        ],
      })],
      nowMs: NOW,
      canPublish: true,
      canEdit: true,
    });
    expect(items.map((item) => item.index)).toEqual([0, 1, 2]);
  });

  it("ограничивает размер ответа и переживает мусорные строки", () => {
    const many = Array.from({ length: 12 }, (_, index) => pendingItem({ i: index }));
    const items = autopilotPlanCalendarItems({
      plans: [null, { id: "not-a-number", items: many }, plan({ items: many }), plan({ id: 42, items: many })],
      nowMs: NOW,
      canPublish: true,
      canEdit: true,
      limit: 5,
    });
    expect(items).toHaveLength(5);
    expect(items.every((item) => item.planId === 41)).toBe(true);
    expect(AUTOPILOT_CALENDAR_PLAN_LIMIT).toBeGreaterThan(0);
  });

  it("не падает на плане без items", () => {
    expect(autopilotPlanCalendarItems({ plans: [{ id: 1, channel_id: 2, status: "pending", revision: 1 }], nowMs: NOW })).toEqual([]);
    expect(autopilotPlanCalendarItems()).toEqual([]);
  });

  it("блокирует элемент, если в редакторе сохранены новые правки", () => {
    const withDraft = (editorVersion) => plan({ items: [pendingItem({ draftId: 77, editorVersion })] });
    const stale = autopilotPlanCalendarItems({
      plans: [withDraft(3)],
      nowMs: NOW,
      canPublish: true,
      canEdit: true,
      draftVersions: new Map([[77, 4]]),
    })[0];
    expect(stale).toMatchObject({ state: "blocked", selectable: false });
    expect(stale.issues.join(" ")).toContain("правки");

    const synced = autopilotPlanCalendarItems({
      plans: [withDraft(4)],
      nowMs: NOW,
      canPublish: true,
      canEdit: true,
      draftVersions: new Map([[77, 4]]),
    })[0];
    expect(synced).toMatchObject({ state: "ready", selectable: true });
  });

  it("без карты версий ведёт себя как раньше", () => {
    const [card] = autopilotPlanCalendarItems({
      plans: [plan({ items: [pendingItem({ draftId: 77, editorVersion: 4 })] })],
      nowMs: NOW,
      canPublish: true,
      canEdit: true,
    });
    expect(card.state).toBe("ready");
  });
});
