import { describe, expect, it } from "vitest";

import {
  SITE_INTERVIEW_CATALOG_VERSION,
  SITE_INTERVIEW_CATEGORIES,
  SITE_INTERVIEW_QUESTIONS,
  validateSiteInterviewCatalog,
} from "./questions";

describe("site OSINT interview question catalog", () => {
  it("is valid, versioned and covers every required category", () => {
    expect(SITE_INTERVIEW_CATALOG_VERSION).toBe("site-osint-questions-v1");
    expect(validateSiteInterviewCatalog()).toEqual({
      ok: true,
      errors: [],
      count: SITE_INTERVIEW_QUESTIONS.length,
    });
    expect(new Set(SITE_INTERVIEW_QUESTIONS.map((question) => question.category)))
      .toEqual(new Set(SITE_INTERVIEW_CATEGORIES.map((category) => category.id)));
    expect(SITE_INTERVIEW_QUESTIONS.length).toBeGreaterThanOrEqual(50);
  });

  it("keeps stable IDs and all mandatory contract fields", () => {
    const ids = SITE_INTERVIEW_QUESTIONS.map((question) => question.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("experts.competencies");
    expect(ids).toContain("partners.validation");
    expect(ids).toContain("public_activity.timeline");
    expect(ids).toContain("constraints.coverage");
    expect(SITE_INTERVIEW_QUESTIONS.every((question) => question.required)).toBe(true);
    expect(SITE_INTERVIEW_QUESTIONS.every((question) => question.version === 1)).toBe(true);
  });

  it("rejects a duplicate ID and an invalid contract", () => {
    const first = SITE_INTERVIEW_QUESTIONS[0];
    const invalid = [first, { ...first, title: "", answerType: "unknown" }] as never;
    const result = validateSiteInterviewCatalog(invalid);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      `duplicate question id: ${first.id}`,
      `${first.id}: missing title`,
      `${first.id}: invalid answerType`,
    ]));
  });
});
