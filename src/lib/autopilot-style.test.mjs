import { describe, expect, it } from "vitest";

import {
  applyAutopilotQuickSettingsToQuality,
  autopilotEnergyPrompt,
  autopilotNewsPostCount,
  normalizeAutopilotQuickSettings,
} from "./autopilot-style.mjs";

describe("Autopilot quick settings", () => {
  it("normalizes the compact controls at the server boundary", () => {
    expect(normalizeAutopilotQuickSettings({
      newsPerWeek: 99,
      detail: 0,
      energy: 2.4,
      emoji: -4,
    })).toEqual({ newsPerWeek: 7, detail: 1, energy: 2, emoji: 0 });
  });

  it("applies the selected length, emoji and news mix", () => {
    expect(applyAutopilotQuickSettingsToQuality({ qualityThreshold: 85 }, {
      detail: 3,
      emoji: 2,
    })).toMatchObject({ minChars: 1_000, maxChars: 1_650, maxEmojis: 3 });
    expect(autopilotNewsPostCount({ newsPerWeek: 3 }, 2, 14)).toBe(6);
    expect(autopilotEnergyPrompt({ energy: 3 })).toContain("Подача живая");
  });
});
