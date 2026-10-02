import { describe, expect, it } from "vitest";

import {
  cleanCategories,
  cleanFingerprints,
  cleanLanguage,
  cleanTopic,
  requestedChannelId,
  topicFromBrief,
} from "./web-research-request";

describe("web research request validation", () => {
  it("accepts only a positive integer channel and never a client float", () => {
    expect(requestedChannelId(null)).toBeNull();
    expect(requestedChannelId("")).toBeNull();
    expect(requestedChannelId("11")).toBe(11);
    expect(requestedChannelId("0")).toBeNaN();
    expect(requestedChannelId("-3")).toBeNaN();
    expect(requestedChannelId("11.5")).toBeNaN();
    expect(requestedChannelId("1e9")).not.toBeNaN();
    expect(Number.isSafeInteger(requestedChannelId("9007199254740993"))).toBe(false);
  });

  it("normalizes the topic and refuses to invent one", () => {
    expect(cleanTopic("  юридическая   практика \n договоры ")).toBe("юридическая практика договоры");
    expect(cleanTopic("   ")).toBeNull();
    expect(cleanTopic(42)).toBeNull();
    expect(cleanTopic(null)).toBeNull();
    expect(cleanTopic("я".repeat(500))?.length).toBe(300);
  });

  it("keeps only known research categories, without duplicates", () => {
    expect(cleanCategories(["law", "law", "market"])).toEqual(["law", "market"]);
    expect(cleanCategories(["LAW", " benchmark "])).toEqual(["law", "benchmark"]);
    expect(cleanCategories(["выдуманная", 7, null])).toEqual([]);
    expect(cleanCategories("law")).toEqual([]);
    expect(cleanCategories(["law", "market", "technology", "statistics", "society", "benchmark", "law"])).toHaveLength(6);
  });

  it("accepts only the three supported research languages", () => {
    expect(cleanLanguage("ru")).toBe("RU");
    expect(cleanLanguage("ANY")).toBe("ANY");
    expect(cleanLanguage("de")).toBeNull();
    expect(cleanLanguage(7)).toBeNull();
    expect(cleanLanguage(undefined)).toBeNull();
  });

  it("deduplicates fingerprints and drops values the database cannot store", () => {
    expect(cleanFingerprints(["wf-a", "wf-a", " wf-b "])).toEqual(["wf-a", "wf-b"]);
    expect(cleanFingerprints(["", "   ", 12, null])).toEqual([]);
    expect(cleanFingerprints(["x".repeat(81)])).toEqual([]);
    expect(cleanFingerprints("wf-a")).toEqual([]);
    expect(cleanFingerprints(Array.from({ length: 250 }, (_, index) => `wf-${index}`))).toHaveLength(200);
  });

  it("derives the research topic from the channel profile, not from an empty string", () => {
    expect(topicFromBrief({ niche: "Юридическая практика", rubrics: ["Договоры", "Суды"] }))
      .toBe("Юридическая практика, Договоры, Суды");
    expect(topicFromBrief({ niche: "  ", rubrics: [], goal: "Помогать предпринимателям" })).toBe("Помогать предпринимателям");
    expect(topicFromBrief({ niche: null, rubrics: null, goal: null })).toBeNull();
    expect(topicFromBrief(undefined)).toBeNull();
    expect(topicFromBrief({ niche: "Право", rubrics: ["a", "b", "c", "d", "e"] })).toBe("Право, a, b, c");
  });
});
