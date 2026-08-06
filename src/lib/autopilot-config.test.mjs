import { describe, expect, it } from "vitest";
import {
  applyAutopilotPresentation,
  autopilotPresentationVariant,
  autopilotTextSimilarity,
  findAutopilotNearDuplicate,
  normalizePlanningMonths,
  plannedPostCount,
  plannedPostCountForWeeks,
  planningWeeks,
} from "./autopilot-config.mjs";

describe("autopilot planning config", () => {
  it("maps 1–3 months to four-week planning blocks and caps oversized plans", () => {
    expect(planningWeeks(1)).toBe(4);
    expect(planningWeeks(2)).toBe(8);
    expect(planningWeeks(3)).toBe(12);
    expect(normalizePlanningMonths(9)).toBe(1);
    expect(plannedPostCount(7, 1)).toBe(28);
    expect(plannedPostCount(7, 2)).toBe(56);
    expect(plannedPostCount(7, 3)).toBe(84);
    expect(plannedPostCount(30, 3)).toBe(90);
  });

  it("supports every weekly horizon instead of three fixed month presets", () => {
    expect(plannedPostCountForWeeks(7, 3)).toBe(21);
    expect(plannedPostCountForWeeks(7, 5)).toBe(35);
    expect(plannedPostCountForWeeks(7, 10)).toBe(70);
    expect(plannedPostCountForWeeks(30, 12)).toBe(90);
  });

  it("finds copied plans but ignores a genuinely different post", () => {
    const copied = [
      {
        topic: "Когда продают ипотечное жильё при банкротстве",
        draft: "Ипотечное жильё при банкротстве является предметом залога. Поэтому квартиру могут реализовать.",
      },
    ];
    expect(
      findAutopilotNearDuplicate({
        topic: "Ипотечное жильё при банкротстве: когда его продают",
        draft: "При банкротстве ипотечное жильё является предметом залога, поэтому квартиру могут реализовать.",
      }, copied),
    ).not.toBeNull();
    expect(
      findAutopilotNearDuplicate({
        topic: "Как подготовить документы для конференции",
        draft: "Сначала составьте программу выступления, затем проверьте тайминг и материалы для участников.",
      }, copied),
    ).toBeNull();
    expect(autopilotTextSimilarity(copied[0].draft, copied[0].draft)).toBe(1);
  });

  it("varies presentation and only adds decorations allowed by the quality profile", () => {
    const quality = {
      emojiPolicy: "restrained",
      maxEmojis: 2,
      allowedEmoji: "⚖️ 📌",
      hashtagsPolicy: "restrained",
      maxHashtags: 2,
      brandedHashtags: "#право",
    };
    const variant = autopilotPresentationVariant(4, quality);
    const result = applyAutopilotPresentation(
      "Короткий хук\n\nОсновная мысль.",
      variant,
      quality,
      { niche: "банкротство бизнеса", audience: "предприниматели" },
      4,
    );
    expect(result).toMatch(/\p{Extended_Pictographic}/u);
    expect(result).toContain("#право");

    const strict = autopilotPresentationVariant(4, {
      emojiPolicy: "none",
      maxEmojis: 0,
      hashtagsPolicy: "none",
      maxHashtags: 0,
    });
    expect(applyAutopilotPresentation("Текст", strict, {}, {}, 4)).toBe("Текст");
  });
});
