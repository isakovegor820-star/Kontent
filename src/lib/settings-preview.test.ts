import { describe, expect, it } from "vitest";

import { normalizePostQuality } from "./post-quality.mjs";
import { buildSettingsApplicationReport } from "./settings-preview";

describe("settings preview report", () => {
  it("reports configured and missing groups without asking the model to self-audit", () => {
    const report = buildSettingsApplicationReport({
      profile: "Ниша канала: право\n\nСловарь бренда проекта:\n— legal tech → LegalTech",
      quality: normalizePostQuality({
        tone: "спокойный эксперт",
        minChars: 700,
        maxChars: 1200,
        forbiddenPhrases: ["гарантируем"],
      }),
      styleSamples: [],
    });
    expect(report.find((item) => item.id === "channel_context")?.status).toBe("applied");
    expect(report.find((item) => item.id === "brand_dictionary")?.status).toBe("applied");
    expect(report.find((item) => item.id === "style_samples")?.status).toBe("not_configured");
    expect(report.find((item) => item.id === "constraints")?.detail).toContain("стоп-фраз: 1");
  });
});
