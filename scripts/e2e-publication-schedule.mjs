/**
 * Immediate fixtures use the API's minute-precision schedule. Leave at least 30s
 * of its existing 60s skew allowance for HTTP/transaction work; sampling xx:59.999
 * and rounding down otherwise makes an ordinary request expire in transit.
 * This waits on real time and neither advances fixtures nor relaxes API validation.
 */
export async function immediateE2ePublicationSchedule({
  now = () => new Date(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  for (;;) {
    const instant = now();
    const timestamp = instant.getTime();
    if (!Number.isFinite(timestamp)) throw new Error("invalid_e2e_publication_clock");
    const elapsed = timestamp % 60_000;
    if (elapsed > 30_000) {
      await sleep(60_000 - elapsed);
      continue;
    }
    const scheduledAt = new Date(timestamp - elapsed).toISOString();
    return {
      scheduledAt,
      localDate: scheduledAt.slice(0, 10),
      localTime: scheduledAt.slice(11, 16),
      timezone: "UTC",
      offset: "+00:00",
      disambiguation: "reject",
    };
  }
}
