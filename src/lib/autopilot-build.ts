const MIN_BUILD_TIMEOUT_MS = 5 * 60_000;
const PER_POST_TIMEOUT_MS = 60_000;
const MAX_BUILD_TIMEOUT_MS = 15 * 60_000;

/**
 * This is a no-progress deadline, not a limit for the whole plan. Every durable item
 * checkpoint refreshes the activity timestamp used by the API.
 */
export function autopilotBuildTimeoutMs(postFrequency: number): number {
  const frequency = Number.isFinite(postFrequency) ? Math.max(1, Math.round(postFrequency)) : 5;
  return Math.min(MAX_BUILD_TIMEOUT_MS, Math.max(MIN_BUILD_TIMEOUT_MS, frequency * PER_POST_TIMEOUT_MS));
}

export function isAutopilotBuildStale(
  lastActivityAt: string | Date,
  postFrequency: number,
  now = Date.now(),
): boolean {
  const startedAt = new Date(lastActivityAt).getTime();
  return Number.isFinite(startedAt) && now - startedAt >= autopilotBuildTimeoutMs(postFrequency);
}
