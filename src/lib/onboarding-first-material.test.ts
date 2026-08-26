import { describe, expect, it } from "vitest";

import { onboardingDraftReplayAction } from "./onboarding-first-material";

describe("onboardingDraftReplayAction", () => {
  it("uses a newly created draft or an exact idempotent replay", () => {
    expect(onboardingDraftReplayAction({
      created: true,
      requestedText: "Новая мысль",
      draftText: "Новая мысль",
      draftVersion: 1,
    })).toBe("use");
    expect(onboardingDraftReplayAction({
      created: false,
      requestedText: "Та же мысль",
      draftText: "Та же мысль",
      draftVersion: 4,
    })).toBe("use");
  });

  it("updates only an untouched version-one replay", () => {
    expect(onboardingDraftReplayAction({
      created: false,
      requestedText: "Исправленный текст",
      draftText: "Первая попытка",
      draftVersion: 1,
    })).toBe("update");
  });

  it("refuses to overwrite a draft that the editor has already revised", () => {
    expect(onboardingDraftReplayAction({
      created: false,
      requestedText: "Текст из восстановления",
      draftText: "Текст из редактора",
      draftVersion: 2,
    })).toBe("conflict");
  });
});
