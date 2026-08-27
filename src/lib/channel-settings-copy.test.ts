import { describe, expect, it } from "vitest";

import { normalizeBrief } from "./brief";
import { mergeChannelConfiguration } from "./channel-settings-copy";

const settings = (enabled: boolean) => ({
  enabled,
  mode: "confirm" as const,
  post_frequency: 7,
  approvals_streak: 0,
  generation_engine: "navy-deepseek-flash",
  planning_months: 1,
  planning_weeks: 4,
  news_sources: [],
  quick_settings: { newsPerWeek: 2, detail: 2, energy: 2, emoji: 1 },
});

describe("channel settings copy", () => {
  it("copies only selected groups and keeps target-specific values", () => {
    const source = {
      brief: normalizeBrief({
        niche: "Право",
        audience: "Бизнес",
        profileAnswers: { q1: "Анна пишет о праве" },
        quality: { tone: "строго", minChars: 900, maxChars: 1400, maxEmojis: 0 },
        ready: true,
      }),
      settings: settings(true),
    };
    const target = {
      brief: normalizeBrief({
        niche: "Кофе",
        audience: "Бариста",
        profileAnswers: { q1: "Борис пишет о кофе" },
        quality: { tone: "тепло", minChars: 400, maxChars: 700, maxEmojis: 5 },
        ready: true,
      }),
      settings: settings(false),
    };
    const merged = mergeChannelConfiguration(source, target, ["channel", "voice"]);
    expect(merged.brief.niche).toBe("Право");
    expect(merged.brief.profileAnswers).toEqual(target.brief.profileAnswers);
    expect(merged.brief.quality.tone).toBe("строго");
    expect(merged.brief.quality.minChars).toBe(400);
    expect(merged.brief.quality.maxEmojis).toBe(5);
    expect(merged.settings.enabled).toBe(false);
  });

  it("always disables copied autopilot until the target is reviewed", () => {
    const source = { brief: normalizeBrief({ niche: "Право", audience: "Бизнес", ready: true }), settings: settings(true) };
    const target = { brief: normalizeBrief({ niche: "Кофе", audience: "Бариста", ready: true }), settings: settings(false) };
    const merged = mergeChannelConfiguration(source, target, ["autopilot"]);
    expect(merged.settings.enabled).toBe(false);
    expect(merged.settings.mode).toBe("confirm");
  });
});
