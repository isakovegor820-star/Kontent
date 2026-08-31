import { describe, expect, it } from "vitest";

import { telegramHistoryPageDecision } from "./reconnaissance-pagination.mjs";

describe("Telegram reconnaissance pagination", () => {
  it("keeps the normal first collection to one page", () => {
    expect(telegramHistoryPageDecision({ pagePostIds: [120, 119], added: 2 })).toEqual({
      done: true,
      historyComplete: true,
      nextBefore: null,
    });
  });

  it("loads older pages until the last stored message is reached", () => {
    expect(telegramHistoryPageDecision({
      pagePostIds: [140, 139, 138],
      added: 3,
      afterPostId: "120",
    })).toEqual({ done: false, historyComplete: false, nextBefore: 138 });

    expect(telegramHistoryPageDecision({
      pagePostIds: [122, 121, 120],
      added: 3,
      afterPostId: "120",
    })).toEqual({ done: true, historyComplete: true, nextBefore: null });
  });

  it("continues an exhaustive scan without a stored boundary", () => {
    expect(telegramHistoryPageDecision({
      pagePostIds: [30, 29],
      added: 2,
      exhaustive: true,
    })).toEqual({ done: false, historyComplete: false, nextBefore: 29 });
  });

  it("stops on an empty or repeated page", () => {
    expect(telegramHistoryPageDecision({ pagePostIds: [], added: 0, afterPostId: 10 }).done).toBe(true);
    expect(telegramHistoryPageDecision({
      pagePostIds: [20, 19],
      added: 2,
      afterPostId: 10,
      seenBoundaries: new Set([19]),
    }).done).toBe(true);
  });
});
