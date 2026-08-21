import { describe, expect, it } from "vitest";

import {
  applyAutopilotQuickSettingsToQuality,
  autopilotEnergyPrompt,
  autopilotNewsPostCount,
  normalizeAutopilotQuickSettings,
} from "./autopilot-style.mjs";
import { buildQualityPrompt } from "./post-quality.mjs";

describe("Autopilot quick settings", () => {
  it("normalizes the compact controls at the server boundary", () => {
    expect(normalizeAutopilotQuickSettings({
      newsPerWeek: 99,
      detail: 0,
      energy: 2.4,
      emoji: -4,
    })).toEqual({ newsPerWeek: 7, detail: 1, energy: 2, emoji: 0 });
  });

  it("keeps desired length separate from the hard publication envelope", () => {
    const profile = applyAutopilotQuickSettingsToQuality({
      qualityThreshold: 85,
      minChars: 900,
      maxChars: 1_800,
    }, {
      detail: 3,
      emoji: 2,
    });
    expect(profile).toMatchObject({
      minChars: 900,
      maxChars: 1_800,
      desiredMinChars: 900,
      desiredMaxChars: 1_500,
      publicationMinChars: 120,
      publicationMaxChars: 4_096,
      maxEmojis: 3,
    });
    expect(buildQualityPrompt(profile)).toContain("желаемый объём: 900–1500");
    expect(buildQualityPrompt(profile)).not.toContain("объём готового текста: 900–1800");
    expect(autopilotNewsPostCount({ newsPerWeek: 3 }, 2, 14)).toBe(6);
    expect(autopilotEnergyPrompt({ energy: 3 })).toContain("Подача живая");
  });
});
