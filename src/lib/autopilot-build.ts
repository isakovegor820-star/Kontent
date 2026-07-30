const MIN_BUILD_TIMEOUT_MS = 30 * 60_000;
const PER_POST_TIMEOUT_MS = 4 * 60_000;
const MAX_BUILD_TIMEOUT_MS = 2 * 60 * 60_000;

/**
 * A plan normally takes a few minutes, but local models and fact-check retries can be slow.
 * The deadline grows with the requested plan size while still guaranteeing that a dead
 * worker cannot leave the UI in `building` forever.
 */
export function autopilotBuildTimeoutMs(postFrequency: number): number {
  const frequency = Number.isFinite(postFrequency) ? Math.max(1, Math.round(postFrequency)) : 5;
  return Math.min(MAX_BUILD_TIMEOUT_MS, Math.max(MIN_BUILD_TIMEOUT_MS, frequency * PER_POST_TIMEOUT_MS));
}

export function isAutopilotBuildStale(
  createdAt: string | Date,
  postFrequency: number,
  now = Date.now(),
): boolean {
  const startedAt = new Date(createdAt).getTime();
  return Number.isFinite(startedAt) && now - startedAt >= autopilotBuildTimeoutMs(postFrequency);
}

