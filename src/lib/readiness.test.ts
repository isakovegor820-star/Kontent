import { describe, expect, it } from "vitest";
import {
  evaluateReadiness,
  isFreshPublicationHeartbeat,
  isFreshTelegramPollingHeartbeat,
  readinessRequestFailure,
  telegramPollingHeartbeatState,
} from "./readiness";

const provider = {
  engine: "openai" as const,
  state: "closed" as const,
  consecutiveTransientFailures: 0,
  successes: 2,
  failures: 0,
  lastOutcome: "success" as const,
  lastFailureCode: null,
  lastLatencyMs: 120,
  updatedAt: "2026-08-01T12:00:00.000Z",
  retryAt: null,
};

const readySchema = {
  ready: true,
  expectedVersion: "aurora-test",
  actualVersion: "aurora-test",
  appliedMigrations: 1,
  expectedMigrations: 1,
  reasons: [],
};

const healthyDefaults = {
  schema: readySchema,
  aiConfigured: true,
  mailDelivery: "up" as const,
  uploadIngress: "up" as const,
  tokenEncryption: "up" as const,
  trackingSecrets: "up" as const,
  telegramPolling: "up" as const,
};

describe("readiness model", () => {
  it("keeps web readiness independent from the publication worker", () => {
    const report = evaluateReadiness({
      ...healthyDefaults,
      database: "up",
      redis: "up",
      publicationWorker: "down",
      aiProviders: [provider],
      checkedAt: new Date("2026-08-01T12:00:00Z"),
    });
    expect(report).toMatchObject({
      status: "degraded",
      webReady: true,
      publicationReady: false,
      telegramBotReady: true,
      aiReady: true,
    });
  });

  it("does not mistake a publication-only worker for a live Telegram bot", () => {
    expect(evaluateReadiness({
      ...healthyDefaults,
      database: "up",
      redis: "up",
      publicationWorker: "up",
      telegramPolling: "down",
      aiProviders: [provider],
    })).toMatchObject({
      status: "degraded",
      publicationReady: true,
      telegramBotReady: false,
      reasons: expect.arrayContaining(["telegram_polling_unavailable"]),
    });
  });

  it("reports a second Telegram poller as a distinct degraded state", () => {
    expect(evaluateReadiness({
      ...healthyDefaults,
      database: "up",
      redis: "up",
      publicationWorker: "up",
      telegramPolling: "conflict",
      aiProviders: [provider],
    })).toMatchObject({
      status: "degraded",
      telegramBotReady: false,
      reasons: expect.arrayContaining(["telegram_polling_conflict"]),
      checks: { telegramPolling: "conflict" },
    });
  });

  it("marks the web not ready only when its database dependency is unavailable", () => {
    expect(evaluateReadiness({
      ...healthyDefaults,
      database: "down",
      redis: "up",
      publicationWorker: "up",
      aiProviders: [],
    })).toMatchObject({ status: "not_ready", webReady: false });
  });

  it("fails closed when PostgreSQL is reachable but the runtime schema is incompatible", () => {
    const report = evaluateReadiness({
      database: "up",
      // Regression model: the old implementation ignores this capability result and
      // incorrectly reports the web tier ready after `select 1` succeeds.
      schema: {
        ready: false,
        expectedVersion: "aurora-test",
        actualVersion: null,
        appliedMigrations: 0,
        expectedMigrations: 1,
        reasons: ["capability_missing:table:drafts"],
      },
      redis: "up",
      publicationWorker: "up",
      telegramPolling: "up",
      aiProviders: [provider],
      aiConfigured: true,
      mailDelivery: "up",
      uploadIngress: "up",
      tokenEncryption: "up",
      trackingSecrets: "up",
    });

    expect(report).toMatchObject({
      status: "not_ready",
      webReady: false,
      publicationReady: false,
      telegramBotReady: false,
      schemaReady: false,
      reasons: ["capability_missing:table:drafts"],
    });
  });

  it("fails web readiness when the production upload ingress limit is not configured", () => {
    expect(evaluateReadiness({
      ...healthyDefaults,
      database: "up",
      redis: "up",
      publicationWorker: "up",
      aiProviders: [provider],
      uploadIngress: "not_configured",
    })).toMatchObject({
      status: "not_ready",
      webReady: false,
      publicationReady: true,
      telegramBotReady: true,
      uploadReady: false,
      tokenEncryptionReady: true,
      reasons: expect.arrayContaining(["avatar_ingress_limit_not_configured"]),
    });
  });

  it("does not call an unobserved AI service production-ready", () => {
    const report = evaluateReadiness({
      ...healthyDefaults,
      database: "up",
      redis: "up",
      publicationWorker: "up",
      aiProviders: [],
    });
    expect(report).toMatchObject({ status: "degraded", aiReady: false });
  });

  it("reports an open observed AI circuit as degraded", () => {
    const report = evaluateReadiness({
      ...healthyDefaults,
      database: "up",
      redis: "up",
      publicationWorker: "up",
      aiProviders: [{ ...provider, state: "open" }],
    });
    expect(report).toMatchObject({ status: "degraded", aiReady: false });
  });

  it("fails closed when the readiness request itself is unreachable", () => {
    expect(readinessRequestFailure()).toEqual({
      webReady: false,
      publicationReady: false,
      telegramBotReady: false,
      aiReady: false,
      schemaReady: false,
      mailDeliveryReady: false,
      uploadReady: false,
      tokenEncryptionReady: false,
      trackingReady: false,
    });
  });
});

describe("publication heartbeat", () => {
  const now = new Date("2026-08-01T12:00:30Z").getTime();

  it("accepts only a fresh publication-role payload", () => {
    expect(isFreshPublicationHeartbeat(JSON.stringify({
      version: 1,
      role: "publication",
      at: "2026-08-01T12:00:01.000Z",
    }), now)).toBe(true);
    expect(isFreshPublicationHeartbeat(JSON.stringify({
      version: 1,
      role: "media",
      at: "2026-08-01T12:00:29.000Z",
    }), now)).toBe(false);
  });

  it("rejects stale or malformed values", () => {
    expect(isFreshPublicationHeartbeat(JSON.stringify({
      version: 1,
      role: "publication",
      at: "2026-08-01T11:59:00.000Z",
    }), now)).toBe(false);
    expect(isFreshPublicationHeartbeat("not-json", now)).toBe(false);
  });
});

describe("Telegram polling heartbeat", () => {
  const now = new Date("2026-08-01T12:01:15Z").getTime();

  it("requires a fresh telegram_polling role", () => {
    expect(isFreshTelegramPollingHeartbeat(JSON.stringify({
      version: 1,
      role: "telegram_polling",
      state: "up",
      at: "2026-08-01T12:00:01.000Z",
    }), now)).toBe(true);
    expect(isFreshTelegramPollingHeartbeat(JSON.stringify({
      version: 1,
      role: "publication",
      state: "up",
      at: "2026-08-01T12:01:14.000Z",
    }), now)).toBe(false);
  });

  it("keeps a polling conflict fresh but unhealthy", () => {
    const raw = JSON.stringify({
      version: 1,
      role: "telegram_polling",
      state: "conflict",
      at: "2026-08-01T12:01:14.000Z",
    });
    expect(telegramPollingHeartbeatState(raw, now)).toBe("conflict");
    expect(isFreshTelegramPollingHeartbeat(raw, now)).toBe(false);
  });
});
