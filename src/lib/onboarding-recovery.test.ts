import { describe, expect, it } from "vitest";
import {
  onboardingRecoveryKey,
  parseOnboardingRecovery,
  serializeOnboardingRecovery,
} from "./onboarding-recovery";

describe("account-scoped onboarding recovery", () => {
  it("uses a distinct browser key for every authenticated account", () => {
    expect(onboardingRecoveryKey(7)).toBe("aurora-onboarding-quiz-v3:7");
    expect(onboardingRecoveryKey(8)).not.toBe(onboardingRecoveryKey(7));
    expect(() => onboardingRecoveryKey(0)).toThrow(/invalid/u);
  });

  it("round-trips the locked channel together with quiz and step", () => {
    const value = {
      quiz: {
        niche: "Право",
        goal: "Лиды",
        audience: "Предприниматели",
        rubrics: ["Кейс"],
        formats: ["Текст"],
        authorRole: "Юрист-практик",
        cta: "Записаться на консультацию",
        taboo: "Не обещать результат",
        tone: "Экспертный и спокойный",
      },
      step: 3,
      channelId: 42,
    };
    expect(parseOnboardingRecovery(serializeOnboardingRecovery(value))).toEqual(value);
  });

  it("fails closed for malformed data and never invents a channel owner", () => {
    expect(parseOnboardingRecovery("not-json")).toBeNull();
    expect(parseOnboardingRecovery(JSON.stringify({ quiz: {}, step: 3, channelId: 42 }))).toBeNull();
    expect(parseOnboardingRecovery(JSON.stringify({
      quiz: { niche: "A", goal: "", audience: "B", rubrics: [] },
      step: 99,
      channelId: "42",
    }))).toEqual({
      quiz: {
        niche: "A",
        goal: "",
        audience: "B",
        rubrics: [],
        formats: [],
        authorRole: "",
        cta: "",
        taboo: "",
        tone: "",
      },
      step: 5,
      channelId: null,
    });
  });
});
