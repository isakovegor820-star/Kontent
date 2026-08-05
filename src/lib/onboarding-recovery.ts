export interface OnboardingQuizAnswers {
  niche: string;
  goal: string;
  audience: string;
  rubrics: string[];
}

export interface OnboardingRecovery {
  quiz: OnboardingQuizAnswers;
  step: number;
  channelId: number | null;
}

export function onboardingRecoveryKey(userId: number): string {
  if (!Number.isInteger(userId) || userId <= 0) throw new Error("invalid onboarding user id");
  return `aurora-onboarding-quiz-v3:${userId}`;
}

export function parseOnboardingRecovery(raw: string | null): OnboardingRecovery | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OnboardingRecovery> | null;
    const quiz = value?.quiz;
    if (
      !quiz ||
      typeof quiz.niche !== "string" ||
      typeof quiz.goal !== "string" ||
      typeof quiz.audience !== "string" ||
      !Array.isArray(quiz.rubrics) ||
      quiz.rubrics.some((rubric) => typeof rubric !== "string") ||
      !Number.isFinite(value?.step)
    ) {
      return null;
    }
    return {
      quiz: {
        niche: quiz.niche,
        goal: quiz.goal,
        audience: quiz.audience,
        rubrics: quiz.rubrics,
      },
      step: Math.min(5, Math.max(1, Math.round(Number(value?.step)))),
      channelId:
        Number.isInteger(value?.channelId) && Number(value?.channelId) > 0
          ? Number(value?.channelId)
          : null,
    };
  } catch {
    return null;
  }
}

export function serializeOnboardingRecovery(value: OnboardingRecovery): string {
  return JSON.stringify(value);
}
