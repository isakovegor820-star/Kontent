import { describe, expect, it } from "vitest";
import {
  decideTelegramAggregateReconciliation,
  decideTelegramReconciliation,
  parseTelegramPublicStats,
  temporaryTelegramVerification,
} from "./telegram-reconciliation.mjs";

const parseCount = (value) => Number(value);
const sumReactions = () => 3;

describe("Telegram reconciliation", () => {
  it("recognizes a live external message and its metrics", () => {
    const result = parseTelegramPublicStats(
      '<div data-post="channel/42"><div class="tgme_widget_message_text">Пост<br>вручную &amp; честно</div><time datetime="2026-09-01T10:00:00+00:00"></time><span class="tgme_widget_message_views">5</span></div>',
      parseCount,
      sumReactions,
    );
    expect(
      decideTelegramReconciliation({ externalMessageId: 42, result }),
    ).toEqual({ kind: "seen", metrics: { views: 5, reactions: 3 } });
    expect(result.posts).toEqual([{
      externalMessageId: 42,
      text: "Пост\nвручную & честно",
      publishedAt: "2026-09-01T10:00:00.000Z",
    }]);
  });

  it("requires two successful in-window misses before declaring a message missing", () => {
    const result = {
      kind: "window",
      messages: { 40: { views: 1, reactions: 0 }, 44: { views: 2, reactions: 0 } },
      oldestSeen: 40,
    };
    expect(
      decideTelegramReconciliation({ externalMessageId: 42, result, consecutiveMissingChecks: 0 }),
    ).toEqual({ kind: "suspected_missing", missingChecks: 1 });
    expect(
      decideTelegramReconciliation({ externalMessageId: 42, result, consecutiveMissingChecks: 1 }),
    ).toEqual({ kind: "confirmed_missing", missingChecks: 2 });
  });

  it("does not call an older out-of-window message missing", () => {
    const result = { kind: "window", messages: { 40: {} }, oldestSeen: 40 };
    expect(decideTelegramReconciliation({ externalMessageId: 12, result })).toEqual({
      kind: "out_of_window",
    });
  });

  it("preserves state on a temporary Telegram timeout", () => {
    const result = temporaryTelegramVerification("timeout", "request timed out");
    expect(decideTelegramReconciliation({ externalMessageId: 42, result })).toEqual({
      kind: "temporary_error",
      errorCode: "timeout",
      reason: "request timed out",
    });
  });

  it("requires every publication part and aggregates metrics without double-counting views", () => {
    const parts = [
      { part_index: 0, external_message_id: "41", send_status: "sent" },
      { part_index: 1, external_message_id: "42", send_status: "sent" },
    ];
    const result = {
      kind: "window",
      messages: {
        41: { views: 100, reactions: 2 },
        42: { views: 90, reactions: 3 },
      },
      oldestSeen: 40,
    };
    expect(decideTelegramAggregateReconciliation({ parts, result })).toMatchObject({
      kind: "seen",
      metrics: { views: 100, reactions: 5 },
    });
  });

  it("marks the aggregate missing only after the missing part is confirmed twice", () => {
    const parts = [
      { part_index: 0, external_message_id: "41", send_status: "sent" },
      { part_index: 1, external_message_id: "42", send_status: "sent" },
    ];
    const result = {
      kind: "window",
      messages: { 41: { views: 100, reactions: 2 }, 43: { views: 1, reactions: 0 } },
      oldestSeen: 40,
    };
    expect(decideTelegramAggregateReconciliation({ parts, result })).toMatchObject({
      kind: "suspected_missing",
      missingChecks: 1,
    });
    expect(decideTelegramAggregateReconciliation({
      parts,
      result,
      consecutiveMissingChecks: 1,
    })).toMatchObject({
      kind: "confirmed_missing",
      missingPartIndexes: [1],
    });
  });
});
