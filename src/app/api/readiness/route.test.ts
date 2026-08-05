import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probeDatabaseAndSchema: vi.fn(),
  probeRedisAndPublicationWorker: vi.fn(),
  probeAiConfiguration: vi.fn(),
  probeMailDeliveryConfiguration: vi.fn(),
  aiProviderHealthSnapshot: vi.fn(),
}));

vi.mock("@/lib/readiness-probes", () => ({
  probeDatabaseAndSchema: mocks.probeDatabaseAndSchema,
  probeRedisAndPublicationWorker: mocks.probeRedisAndPublicationWorker,
  probeAiConfiguration: mocks.probeAiConfiguration,
  probeMailDeliveryConfiguration: mocks.probeMailDeliveryConfiguration,
}));
vi.mock("@/lib/ai-provider-health", () => ({
  aiProviderHealthSnapshot: mocks.aiProviderHealthSnapshot,
}));

import { GET } from "./route";

describe("GET /api/readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.probeDatabaseAndSchema.mockResolvedValue({
      database: "up",
      schema: {
        ready: true,
        expectedVersion: "aurora-test",
        actualVersion: "aurora-test",
        appliedMigrations: 1,
        expectedMigrations: 1,
        reasons: [],
      },
    });
    mocks.probeRedisAndPublicationWorker.mockResolvedValue({
      redis: "up",
      publicationWorker: "up",
    });
    mocks.probeAiConfiguration.mockReturnValue(true);
    mocks.probeMailDeliveryConfiguration.mockReturnValue("up");
    mocks.aiProviderHealthSnapshot.mockReturnValue([{
      engine: "openai",
      state: "closed",
      consecutiveTransientFailures: 0,
      successes: 1,
      failures: 0,
      lastOutcome: "success",
      lastFailureCode: null,
      lastLatencyMs: 100,
      updatedAt: "2026-08-02T00:00:00.000Z",
      retryAt: null,
    }]);
  });

  it("returns 200 for a usable web even when publication is degraded", async () => {
    mocks.probeRedisAndPublicationWorker.mockResolvedValue({
      redis: "up",
      publicationWorker: "down",
    });
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      webReady: true,
      publicationReady: false,
    });
  });

  it("returns 503 when the web database dependency is down", async () => {
    mocks.probeDatabaseAndSchema.mockResolvedValue({
      database: "down",
      schema: {
        ready: false,
        expectedVersion: "aurora-test",
        actualVersion: null,
        appliedMigrations: 0,
        expectedMigrations: 1,
        reasons: ["schema_not_checked:database_unreachable"],
      },
    });
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      webReady: false,
    });
  });

  it("returns 503 with exact schema reasons for a reachable legacy database", async () => {
    mocks.probeDatabaseAndSchema.mockResolvedValue({
      database: "up",
      schema: {
        ready: false,
        expectedVersion: "aurora-test",
        actualVersion: null,
        appliedMigrations: 0,
        expectedMigrations: 1,
        reasons: ["capability_missing:table:drafts"],
      },
    });
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      processAlive: true,
      databaseReady: true,
      schemaReady: false,
      webReady: false,
      publicationReady: false,
      reasons: ["capability_missing:table:drafts"],
    });
  });

  it("keeps web usable but reports recovery degraded when mail is unconfigured", async () => {
    mocks.probeMailDeliveryConfiguration.mockReturnValue("not_configured");
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      webReady: true,
      mailDeliveryReady: false,
      passwordRecoveryReady: false,
      reasons: ["mail_delivery_not_configured"],
    });
  });
});
