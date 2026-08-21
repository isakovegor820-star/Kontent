import { describe, expect, it } from "vitest";

import { rankTodayItems, type TodayItem } from "./today";

const item = (type: TodayItem["type"], priority: number, fingerprint: string): TodayItem => ({
  fingerprint: fingerprint.repeat(64).slice(0, 64), type, priority, title: type, whyNow: "Почему сейчас",
  channelId: 1, channelLabel: "Канал", confidence: "medium", epistemicState: "inferred", freshness: "сейчас",
  primaryAction: { label: "Открыть", href: "/app/calendar" }, secondaryAction: null, evidence: null,
});

describe("Today deterministic ranking", () => {
  it("ranks by server priority and stable type/fingerprint tie-breaks", () => {
    const ranked = rankTodayItems([item("result", 70, "c"), item("risk", 100, "b"), item("review", 100, "a")]);
    expect(ranked.map((entry) => entry.type)).toEqual(["risk", "review", "result"]);
  });

  it("never returns more than five decisions", () => {
    expect(rankTodayItems(Array.from({ length: 9 }, (_, index) => item("opportunity", index, String(index))))).toHaveLength(5);
  });
});
