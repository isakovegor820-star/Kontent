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

function isQueryTimeout(error) {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code || "") : "";
  return code === "57014"
    || /query read timeout|canceling statement due to statement timeout|query timeout/iu.test(error.message);
}

function durationMillis(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function sample(values, value) {
  values.push(durationMillis(value));
  if (values.length > SAMPLE_LIMIT) values.shift();
}

function maximum(values) {
  return values.length > 0 ? Math.max(...values) : null;
}

export class DatabasePoolMonitor {
  #acquireWaitSamples = [];
  #acquireTimeouts = 0;
  #acquireErrors = 0;
  #recentErrors = [];
  #lastErrorAt = null;
  #now;
  #queryDurationSamples = [];
  #slowQueries = 0;
  #queryTimeouts = 0;
  #queryErrors = 0;
  #transactionDurationSamples = [];
  #activeTransactions = 0;
  #committedTransactions = 0;
  #rolledBackTransactions = 0;
  #abandonedTransactions = 0;
  #transactionErrors = 0;

  constructor(now = Date.now) { this.#now = now; }

  recordAcquire(waitMs, error) {
    sample(this.#acquireWaitSamples, waitMs);
    if (error) {
      this.#acquireErrors += 1;
      this.#lastErrorAt = this.#now();
      this.#recentErrors.push(this.#lastErrorAt);
      if (this.#recentErrors.length > SAMPLE_LIMIT) this.#recentErrors.shift();
    }
    if (isAcquireTimeout(error)) this.#acquireTimeouts += 1;
  }

  recordQuery(durationMs, error, slowQueryThresholdMillis) {
    const duration = durationMillis(durationMs);
    sample(this.#queryDurationSamples, duration);
    if (duration >= slowQueryThresholdMillis) this.#slowQueries += 1;
    if (error) this.#queryErrors += 1;
    if (isQueryTimeout(error)) this.#queryTimeouts += 1;
  }

  recordTransactionStarted() {
    this.#activeTransactions += 1;
  }

  recordTransaction(durationMs, outcome) {
    this.#activeTransactions = Math.max(0, this.#activeTransactions - 1);
    sample(this.#transactionDurationSamples, durationMs);
    if (outcome === "committed") this.#committedTransactions += 1;
    else if (outcome === "rolled_back") this.#rolledBackTransactions += 1;
    else if (outcome === "abandoned") this.#abandonedTransactions += 1;
    else this.#transactionErrors += 1;
  }

  snapshot(pool, config) {
    const now = this.#now();
    this.#recentErrors = this.#recentErrors.filter(at => at > now - RECENT_WINDOW_MS);
    const total = Number(pool?.totalCount || 0);
    const idle = Number(pool?.idleCount || 0);
    return {
      schemaVersion: 2,
      metricsScope: "process",
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
      queryDurationP95Ms: percentile95(this.#queryDurationSamples),
      queryDurationMaxMs: maximum(this.#queryDurationSamples),
      querySamples: this.#queryDurationSamples.length,
      slowQueries: this.#slowQueries,
      queryTimeouts: this.#queryTimeouts,
      queryErrors: this.#queryErrors,
      transactionDurationP95Ms: percentile95(this.#transactionDurationSamples),
      transactionDurationMaxMs: maximum(this.#transactionDurationSamples),
      transactionSamples: this.#transactionDurationSamples.length,
      activeTransactions: this.#activeTransactions,
      committedTransactions: this.#committedTransactions,
      rolledBackTransactions: this.#rolledBackTransactions,
      abandonedTransactions: this.#abandonedTransactions,
      transactionErrors: this.#transactionErrors,
      connectionTimeoutMillis: config.connectionTimeoutMillis,
      queryTimeoutMillis: config.queryTimeoutMillis,
      slowQueryThresholdMillis: config.slowQueryThresholdMillis,
      statementTimeoutMillis: config.statementTimeoutMillis,
      idleInTransactionTimeoutMillis: config.idleInTransactionTimeoutMillis,
    };
  }
}
