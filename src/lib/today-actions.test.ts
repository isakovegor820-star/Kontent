import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadTodayBoard: vi.fn(),
  createOpportunitySourceContext: vi.fn(),
  createPublishedPostSourceContext: vi.fn(),
}));

vi.mock("./today", async (importOriginal) => {
  const original = await importOriginal<typeof import("./today")>();
  return { ...original, loadTodayBoard: mocks.loadTodayBoard };
});
vi.mock("./content-intelligence", async (importOriginal) => {
  const original = await importOriginal<typeof import("./content-intelligence")>();
  return {
    ...original,
    createOpportunitySourceContext: mocks.createOpportunitySourceContext,
    createPublishedPostSourceContext: mocks.createPublishedPostSourceContext,
  };
});

import { performTodaySmartAction } from "./today-actions";

function board(action: Record<string, unknown> | null) {
  return {
    enabled: true,
    items: [{ fingerprint: "a".repeat(64), smartAction: action }],
  };
}

describe("Today smart actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createOpportunitySourceContext.mockResolvedValue({ draftId: 41, created: true });
    mocks.createPublishedPostSourceContext.mockResolvedValue({ draftId: 42, created: true });
  });

  it("validates the current server-generated action before creating anything", async () => {
    mocks.loadTodayBoard.mockResolvedValue(board({ kind: "continue_post", subjectId: 91 }));
    await expect(performTodaySmartAction({
      actorUserId: 9, channelId: 11, fingerprint: "a".repeat(64), actionKind: "improve_post",
    })).rejects.toMatchObject({ code: "action_changed" });
    expect(mocks.createPublishedPostSourceContext).not.toHaveBeenCalled();
  });

  it("creates an idempotent opportunity context and carries a real calendar date", async () => {
    mocks.loadTodayBoard.mockResolvedValue(board({ kind: "fill_calendar_gap", subjectId: 71, scheduledLocalDate: "2026-08-25" }));
    const result = await performTodaySmartAction({
      actorUserId: 9, channelId: 11, fingerprint: "a".repeat(64), actionKind: "fill_calendar_gap",
    });
    expect(mocks.createOpportunitySourceContext).toHaveBeenCalledWith({ actorUserId: 9, opportunityId: 71 });
    expect(result.href).toBe("/app/studio?draft=41&intent=create&calendarDate=2026-08-25");
  });

  it.each([
    ["continue_post", "continue"],
    ["improve_post", "improve"],
  ] as const)("creates a separate source context for %s without editing the published post", async (kind, mode) => {
    mocks.loadTodayBoard.mockResolvedValue(board({ kind, subjectId: 91 }));
    const result = await performTodaySmartAction({
      actorUserId: 9, channelId: 11, fingerprint: "a".repeat(64), actionKind: kind,
    });
    expect(mocks.createPublishedPostSourceContext).toHaveBeenCalledWith({ actorUserId: 9, postId: 91, channelId: 11, mode });
    expect(result.href).toBe("/app/studio?draft=42&intent=create");
  });
});
