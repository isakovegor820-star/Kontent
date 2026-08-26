export function onboardingEntryWasIncomplete(
  current: boolean | null,
  onboarded: boolean,
): boolean {
  return current ?? !onboarded;
}

export function completedOnboardingFallbackRoute(
  onboarded: boolean,
  startedIncomplete: boolean | null,
): "/app/calendar" | null {
  return onboarded && startedIncomplete === false ? "/app/calendar" : null;
}
