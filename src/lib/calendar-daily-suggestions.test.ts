import { describe, expect, it } from "vitest";

import {
  buildCalendarDailySuggestions,
  calendarSuggestionComposerHref,
} from "./calendar-daily-suggestions";

describe("calendar daily suggestions", () => {
  it("always offers a scenario, a trend action and one rotating format", () => {
    const suggestions = buildCalendarDailySuggestions({
      localDate: "2026-08-31",
      niche: "банкротство физических лиц",
    });

    expect(suggestions.map((item) => item.kind)).toEqual(["script", "trend", "format"]);
    expect(suggestions[0].title).toContain("банкротство физических лиц");
    expect(suggestions[1].title).toContain("Проверьте");
    expect(calendarSuggestionComposerHref(suggestions[0])).toContain("assistant=script");
  });

  it("uses a verified feed candidate without copying its text into the prompt", () => {
    const trend = buildCalendarDailySuggestions({
      localDate: "2026-08-31",
      channelLabel: "Аврора",
      trends: [{
        id: 91,
        text: "Почему люди откладывают сложное решение",
        competitorTitle: "Публичный источник",
        handle: "source",
        ratio: 2.4,
        idea: { topic: "Как спокойно принять сложное решение", hook: null },
      }],
    })[1];

    expect(trend.title).toBe("Как спокойно принять сложное решение");
    expect(trend.multiplier).toBe(2.4);
    expect(trend.prompt).toContain("Не копируй формулировки");
  });

  it("rotates the third format when the project day changes", () => {
    const first = buildCalendarDailySuggestions({ localDate: "2026-08-31" });
    const next = buildCalendarDailySuggestions({ localDate: "2026-09-01" });

    expect(first[2].id).not.toBe(next[2].id);
    expect(first[2].label).not.toBe(next[2].label);
  });
});
