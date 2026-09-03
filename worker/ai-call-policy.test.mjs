import { describe, expect, it } from "vitest";
import { assertWorkerAiCallPolicy, WORKER_AI_SURFACES } from "./ai-call-policy.mjs";

describe("worker AI call policy", () => {
  it("keeps visible generation surfaces on the shared user quota", () => {
    expect(Object.entries(WORKER_AI_SURFACES)
      .filter(([, policy]) => policy.billing === "user")
      .map(([surface]) => surface)
      .sort()).toEqual([
      "autopilot-plan",
      "bot-client-reply",
      "bot-idea",
      "bot-intake",
      "competitor-idea",
      "media-generation",
      "radar-osint-profile",
      "rss-summary",
      "site-analysis-interview",
      "site-article",
      "site-report-interpretation",
      "site-visibility-probe",
    ]);
    expect(assertWorkerAiCallPolicy("rss-summary", 91)).toMatchObject({
      billing: "user",
      purpose: "scheduled_user_post",
    });
    expect(() => assertWorkerAiCallPolicy("rss-summary")).toThrow(/reservation/u);
    expect(assertWorkerAiCallPolicy("radar-osint-profile", 92)).toMatchObject({
      billing: "user",
      purpose: "visible_osint_profile",
    });
  });

  it("marks only internal classification, retrieval and maintenance as non-billable", () => {
    expect(Object.entries(WORKER_AI_SURFACES)
      .filter(([, policy]) => policy.billing === "system")
      .map(([surface]) => surface)
      .sort()).toEqual([
      "competitor-niche-classifier",
      "competitor-reader-classifier",
      "knowledge-embedding",
      "profile-refresh",
      "radar-query-expansion",
      "site-page-classifier",
    ]);
    expect(assertWorkerAiCallPolicy("profile-refresh")).toMatchObject({ billing: "system" });
    expect(() => assertWorkerAiCallPolicy("profile-refresh", 12)).toThrow(/non-billable/u);
  });

  it("rejects unclassified provider calls", () => {
    expect(() => assertWorkerAiCallPolicy("new-magic-feature", 1)).toThrow(/unknown surface/u);
  });
});
