import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  probeDatabaseAndSchema: vi.fn(),
  probeRedisAndPublicationWorker: vi.fn(),
  probeAiConfiguration: vi.fn(),
  probeMailDeliveryConfiguration: vi.fn(),
  probeUploadIngressConfiguration: vi.fn(),
  probeTrackingSecretsConfiguration: vi.fn(),
  aiProviderHealthSnapshot: vi.fn(),
  getSessionUser: vi.fn(),
}));

vi.mock("@/lib/readiness-probes", () => ({
  probeDatabaseAndSchema: mocks.probeDatabaseAndSchema,
  probeRedisAndPublicationWorker: mocks.probeRedisAndPublicationWorker,
  probeAiConfiguration: mocks.probeAiConfiguration,
  probeMailDeliveryConfiguration: mocks.probeMailDeliveryConfiguration,
  probeUploadIngressConfiguration: mocks.probeUploadIngressConfiguration,
  probeTrackingSecretsConfiguration: mocks.probeTrackingSecretsConfiguration,
}));
vi.mock("@/lib/ai-provider-health", () => ({
  aiProviderHealthSnapshot: mocks.aiProviderHealthSnapshot,
}));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));

import { GET } from "./route";

describe("GET /api/readiness", () => {
  const operatorRequest = () => new NextRequest("http://localhost/api/readiness", {
    headers: { authorization: `Bearer ${"r".repeat(32)}` },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("AURORA_READINESS_TOKEN", "r".repeat(32));
    mocks.getSessionUser.mockResolvedValue(null);
    mocks.probeDatabaseAndSchema.mockResolvedValue({
      database: "up",
      tokenEncryption: "up",
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
      telegramPolling: "up",
    });
    mocks.probeAiConfiguration.mockReturnValue(true);
    mocks.probeMailDeliveryConfiguration.mockReturnValue("up");
    mocks.probeUploadIngressConfiguration.mockReturnValue("up");
    mocks.probeTrackingSecretsConfiguration.mockReturnValue("up");
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

  afterEach(() => vi.unstubAllEnvs());

  it("returns 200 for a usable web even when publication is degraded", async () => {
    mocks.probeRedisAndPublicationWorker.mockResolvedValue({
      redis: "up",
      publicationWorker: "down",
      telegramPolling: "up",
    });
    const response = await GET(operatorRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      webReady: true,
      publicationReady: false,
      telegramBotReady: true,
    });
  });

  it("returns 503 when the web database dependency is down", async () => {
    mocks.probeDatabaseAndSchema.mockResolvedValue({
      database: "down",
      tokenEncryption: "down",
      schema: {
        ready: false,
        expectedVersion: "aurora-test",
        actualVersion: null,
        appliedMigrations: 0,
        expectedMigrations: 1,
        reasons: ["schema_not_checked:database_unreachable"],
      },
    });
    const response = await GET(operatorRequest());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "not_ready",
      webReady: false,
    });
  });

  it("returns 503 with exact schema reasons for a reachable legacy database", async () => {
    mocks.probeDatabaseAndSchema.mockResolvedValue({
      database: "up",
      tokenEncryption: "down",
      schema: {
        ready: false,
        expectedVersion: "aurora-test",
        actualVersion: null,
        appliedMigrations: 0,
        expectedMigrations: 1,
        reasons: ["capability_missing:table:drafts"],
      },
    });
    const response = await GET(operatorRequest());
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
    const response = await GET(operatorRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "degraded",
      webReady: true,
      mailDeliveryReady: false,
      passwordRecoveryReady: false,
      reasons: ["mail_delivery_not_configured"],
    });
  });

  it.each([
    ["localhost Host", new NextRequest("http://localhost/api/readiness")],
    ["127.0.0.1 URL", new NextRequest("http://127.0.0.1/api/readiness")],
    ["missing forwarded headers", new NextRequest("https://aurora.example/api/readiness")],
    ["spoofed external forwarded header", new NextRequest("http://127.0.0.1/api/readiness", {
      headers: { "x-forwarded-for": "203.0.113.8" },
    })],
    ["spoofed loopback forwarded header", new NextRequest("https://aurora.example/api/readiness", {
      headers: { "x-forwarded-for": "127.0.0.1" },
    })],
    ["wrong bearer", new NextRequest("https://aurora.example/api/readiness", {
      headers: { authorization: `Bearer ${"x".repeat(32)}` },
    })],
  ])("rejects %s without running dependency probes", async (_label, request) => {
    const response = await GET(request);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(mocks.probeDatabaseAndSchema).not.toHaveBeenCalled();
    expect(mocks.probeRedisAndPublicationWorker).not.toHaveBeenCalled();
  });

  it("does not run dependency probes for a public request", async () => {
    const response = await GET(new NextRequest("https://aurora.example/api/readiness"));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(mocks.probeDatabaseAndSchema).not.toHaveBeenCalled();
    expect(mocks.probeRedisAndPublicationWorker).not.toHaveBeenCalled();
  });

  it("rejects a non-admin session without exposing capability flags", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 7, email: "user@example.test" });
    const response = await GET(new NextRequest("https://aurora.example/api/readiness", {
      headers: { cookie: "sid=user-session" },
    }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(mocks.probeDatabaseAndSchema).not.toHaveBeenCalled();
  });

  it("allows a global administrator session", async () => {
    vi.stubEnv("AURORA_ADMIN_EMAILS", "admin@example.test");
    mocks.getSessionUser.mockResolvedValue({ id: 9, email: "admin@example.test" });
    const response = await GET(new NextRequest("https://aurora.example/api/readiness", {
      headers: { cookie: "sid=admin-session" },
    }));
    expect(response.status).toBe(200);
    expect(mocks.probeDatabaseAndSchema).toHaveBeenCalledOnce();
  });

});
