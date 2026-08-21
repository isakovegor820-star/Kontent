/**
 * A frequently updated progress indicator must stop spinning when the user asks
 * the operating system to reduce motion. Kept pure so the client component and
 * its regression test share the exact policy.
 */
export function autopilotBuildSpinnerClass(reducedMotion) {
  return reducedMotion ? "" : "animate-spin";
}
