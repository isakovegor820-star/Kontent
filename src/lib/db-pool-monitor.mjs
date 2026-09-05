const SAMPLE_LIMIT = 1_024;
const RECENT_WINDOW_MS = 60_000;

function percentile95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
}

function isAcquireTimeout(error) {
  return error instanceof Error
    && /timeout exceeded when trying to connect|connection terminated due to connection timeout/iu.test(error.message);
}

export class DatabasePoolMonitor {
  #acquireWaitSamples = [];
  #acquireTimeouts = 0;
  #acquireErrors = 0;
  #recentErrors = [];
  #lastErrorAt = null;
  #now;

  constructor(now = Date.now) { this.#now = now; }

  recordAcquire(waitMs, error) {
    const duration = Math.max(0, Math.round(Number(waitMs) || 0));
    this.#acquireWaitSamples.push(duration);
    if (this.#acquireWaitSamples.length > SAMPLE_LIMIT) this.#acquireWaitSamples.shift();
    if (error) {
      this.#acquireErrors += 1;
      this.#lastErrorAt = this.#now();
      this.#recentErrors.push(this.#lastErrorAt);
      if (this.#recentErrors.length > SAMPLE_LIMIT) this.#recentErrors.shift();
    }
    if (isAcquireTimeout(error)) this.#acquireTimeouts += 1;
  }

  snapshot(pool, config) {
    const now = this.#now();
    this.#recentErrors = this.#recentErrors.filter(at => at > now - RECENT_WINDOW_MS);
    const total = Number(pool?.totalCount || 0);
    const idle = Number(pool?.idleCount || 0);
    return {
      schemaVersion: 1,
      role: config.role,
      max: config.max,
      total,
      active: Math.max(0, total - idle),
      idle,
      waiting: Number(pool?.waitingCount || 0),
      acquireWaitP95Ms: percentile95(this.#acquireWaitSamples),
      acquireSamples: this.#acquireWaitSamples.length,
      acquireTimeouts: this.#acquireTimeouts,
      acquireErrors: this.#acquireErrors,
      recentAcquireErrors: this.#recentErrors.length,
      recentWindowMs: RECENT_WINDOW_MS,
      lastAcquireErrorAt: this.#lastErrorAt === null ? null : new Date(this.#lastErrorAt).toISOString(),
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      queryTimeoutMillis: config.queryTimeoutMillis,
      statementTimeoutMillis: config.statementTimeoutMillis,
      idleInTransactionTimeoutMillis: config.idleInTransactionTimeoutMillis,
    };
  }
}
