import type { EngineId } from "./engines";

export type ProviderCircuitState = "closed" | "open" | "half_open";
export type ProviderHealthOutcome = "success" | "failure" | "cancelled" | null;

export interface ProviderCircuitPolicy {
  failureThreshold: number;
  openMs: number;
  maxEntries: number;
}

export interface ProviderAttemptPermit {
  allowed: boolean;
  state: ProviderCircuitState;
  retryAt: number | null;
}

export interface ProviderHealthSnapshot {
  engine: EngineId;
  state: ProviderCircuitState;
  consecutiveTransientFailures: number;
  successes: number;
  failures: number;
  lastOutcome: ProviderHealthOutcome;
  lastFailureCode: string | null;
  lastLatencyMs: number | null;
  updatedAt: string | null;
  retryAt: string | null;
}

interface ProviderHealthEntry {
  state: ProviderCircuitState;
  consecutiveTransientFailures: number;
  successes: number;
  failures: number;
  lastOutcome: ProviderHealthOutcome;
  lastFailureCode: string | null;
  lastLatencyMs: number | null;
  updatedAt: number | null;
  retryAt: number | null;
  probeInFlight: boolean;
}

const DEFAULT_POLICY: ProviderCircuitPolicy = {
  failureThreshold: 3,
  openMs: 30_000,
  maxEntries: 32,
};

function boundedInt(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function safeFailureCode(value: string): string {
  // Snapshot не принимает сырой provider message. Даже ошибочный caller не сможет
  // превратить readiness endpoint в канал утечки prompt/ключа.
  return /^[a-z0-9_:-]{1,64}$/u.test(value) ? value : "provider_error";
}

function blankEntry(): ProviderHealthEntry {
  return {
    state: "closed",
    consecutiveTransientFailures: 0,
    successes: 0,
    failures: 0,
    lastOutcome: null,
    lastFailureCode: null,
    lastLatencyMs: null,
    updatedAt: null,
    retryAt: null,
    probeInFlight: false,
  };
}

/** Ограниченная in-process state machine; shared Redis state подключается поверх того же API. */
export class ProviderCircuitBreaker {
  private readonly entries = new Map<EngineId, ProviderHealthEntry>();
  readonly policy: ProviderCircuitPolicy;

  constructor(policy: Partial<ProviderCircuitPolicy> = {}) {
    this.policy = {
      failureThreshold: boundedInt(policy.failureThreshold ?? DEFAULT_POLICY.failureThreshold, 1, 20, DEFAULT_POLICY.failureThreshold),
      openMs: boundedInt(policy.openMs ?? DEFAULT_POLICY.openMs, 100, 10 * 60_000, DEFAULT_POLICY.openMs),
      maxEntries: boundedInt(policy.maxEntries ?? DEFAULT_POLICY.maxEntries, 1, 128, DEFAULT_POLICY.maxEntries),
    };
  }

  private entry(engine: EngineId): ProviderHealthEntry {
    const existing = this.entries.get(engine);
    if (existing) return existing;
    if (this.entries.size >= this.policy.maxEntries) {
      const oldest = [...this.entries.entries()].sort(
        (a, b) => (a[1].updatedAt ?? 0) - (b[1].updatedAt ?? 0),
      )[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    const created = blankEntry();
    this.entries.set(engine, created);
    return created;
  }

  beforeRequest(engine: EngineId, now = Date.now()): ProviderAttemptPermit {
    const entry = this.entry(engine);
    if (entry.state === "open") {
      if (entry.retryAt !== null && now < entry.retryAt) {
        return { allowed: false, state: "open", retryAt: entry.retryAt };
      }
      entry.state = "half_open";
      entry.probeInFlight = false;
    }
    if (entry.state === "half_open") {
      if (entry.probeInFlight) return { allowed: false, state: "half_open", retryAt: entry.retryAt };
      entry.probeInFlight = true;
      entry.updatedAt = now;
      return { allowed: true, state: "half_open", retryAt: entry.retryAt };
    }
    return { allowed: true, state: "closed", retryAt: null };
  }

  recordSuccess(engine: EngineId, latencyMs: number, now = Date.now()): void {
    const entry = this.entry(engine);
    entry.state = "closed";
    entry.consecutiveTransientFailures = 0;
    entry.successes += 1;
    entry.lastOutcome = "success";
    entry.lastFailureCode = null;
    entry.lastLatencyMs = Math.max(0, Math.round(latencyMs));
    entry.updatedAt = now;
    entry.retryAt = null;
    entry.probeInFlight = false;
  }

  recordFailure(
    engine: EngineId,
    input: { code: string; transient: boolean; latencyMs: number },
    now = Date.now(),
  ): void {
    const entry = this.entry(engine);
    const wasHalfOpen = entry.state === "half_open";
    entry.failures += 1;
    entry.lastOutcome = "failure";
    entry.lastFailureCode = safeFailureCode(input.code);
    entry.lastLatencyMs = Math.max(0, Math.round(input.latencyMs));
    entry.updatedAt = now;
    entry.probeInFlight = false;

    if (!input.transient) {
      // 4xx/validation response доказывает, что provider отвечает; breaker не открываем.
      entry.state = "closed";
      entry.consecutiveTransientFailures = 0;
      entry.retryAt = null;
      return;
    }
    entry.consecutiveTransientFailures += 1;
    if (wasHalfOpen || entry.consecutiveTransientFailures >= this.policy.failureThreshold) {
      entry.state = "open";
      entry.retryAt = now + this.policy.openMs;
    }
  }

  recordCancellation(engine: EngineId, now = Date.now()): void {
    const entry = this.entry(engine);
    entry.lastOutcome = "cancelled";
    entry.updatedAt = now;
    if (entry.state === "half_open") {
      // Отмена пользователя ничего не говорит о здоровье probe: оставляем цепь открытой
      // до следующего bounded retry window, но не увеличиваем failure counter.
      entry.state = "open";
      entry.retryAt = now + this.policy.openMs;
    }
    entry.probeInFlight = false;
  }

  snapshot(now = Date.now()): ProviderHealthSnapshot[] {
    return [...this.entries.entries()].map(([engine, entry]) => {
      const state = entry.state === "open" && entry.retryAt !== null && now >= entry.retryAt
        ? "half_open"
        : entry.state;
      return {
        engine,
        state,
        consecutiveTransientFailures: entry.consecutiveTransientFailures,
        successes: entry.successes,
        failures: entry.failures,
        lastOutcome: entry.lastOutcome,
        lastFailureCode: entry.lastFailureCode,
        lastLatencyMs: entry.lastLatencyMs,
        updatedAt: entry.updatedAt === null ? null : new Date(entry.updatedAt).toISOString(),
        retryAt: state === "closed" || entry.retryAt === null ? null : new Date(entry.retryAt).toISOString(),
      };
    });
  }

  reset(): void {
    this.entries.clear();
  }
}

const globalForProviderHealth = globalThis as unknown as {
  auroraProviderCircuitBreaker?: ProviderCircuitBreaker;
};

export const aiProviderCircuitBreaker = globalForProviderHealth.auroraProviderCircuitBreaker
  ?? new ProviderCircuitBreaker({
    failureThreshold: Number(process.env.AI_CIRCUIT_FAILURE_THRESHOLD || DEFAULT_POLICY.failureThreshold),
    openMs: Number(process.env.AI_CIRCUIT_OPEN_MS || DEFAULT_POLICY.openMs),
    maxEntries: Number(process.env.AI_CIRCUIT_MAX_ENTRIES || DEFAULT_POLICY.maxEntries),
  });
globalForProviderHealth.auroraProviderCircuitBreaker = aiProviderCircuitBreaker;

/** Safe для /api/readiness: только агрегаты state machine, без URL, model key, prompt/response. */
export function aiProviderHealthSnapshot(now = Date.now()): ProviderHealthSnapshot[] {
  return aiProviderCircuitBreaker.snapshot(now);
}
