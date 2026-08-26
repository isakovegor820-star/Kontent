export type OnboardingDraftReplayAction = "use" | "update" | "conflict";

/**
 * An idempotent create may return a draft from an earlier onboarding attempt.
 * Version one is still the untouched onboarding snapshot, so the latest form
 * text may safely replace it through the normal compare-and-swap update. Once
 * the version has advanced, the editor owns the newer value and onboarding
 * must never overwrite it silently.
 */
export function onboardingDraftReplayAction(input: {
  created: boolean;
  requestedText: string;
  draftText: string;
  draftVersion: number;
}): OnboardingDraftReplayAction {
  if (input.created || input.requestedText === input.draftText) return "use";
  return input.draftVersion === 1 ? "update" : "conflict";
}
