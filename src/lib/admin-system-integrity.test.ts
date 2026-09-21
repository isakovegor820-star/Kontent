import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  workers: 1, failed: 0, paused: false,
  completedAt: null as number | null,
  providers: [] as { engine: string; state: string; lastOutcome: string; updatedAt: string; lastFailureCode: string }[],
  query: vi.fn(),
  poolSnapshot: { waiting: 0, acquireTimeouts: 4, acquireErrors: 4, recentAcquireErrors: 0 },
}));
vi.mock("bullmq", () => ({ Queue: class {
  keys = { delayed: "test-delayed" };
  client = Promise.resolve({ zrange: async () => [] });
  on() { return this; }
  async getJobCounts() { return { wait: 0, active: 0, delayed: 0, completed: 1, failed: fixture.failed, prioritized: 0, paused: 0, "waiting-children": 0 }; }
  async waitUntilReady() {}
  async getWorkers() { return Array.from({ length: fixture.workers }, () => ({ db: "15" })); }
  async getJobSchedulers() { return []; }
  async isPaused() { return fixture.paused; }
  async getJobs(types: string[]) { return types.includes("completed") && fixture.completedAt ? [{ finishedOn: fixture.completedAt, timestamp: fixture.completedAt - 1000 }] : []; }
  async close() {}
  async disconnect() {}
} }));
vi.mock("ioredis", () => ({ default: class {
  on() {}
  async connect() {}
  async ping() { return "PONG"; }
  async info() { return "used_memory:1024\r\nuptime_in_seconds:300\r\nconnected_clients:3"; }
  async mget() { return [JSON.stringify({ version: 1, role: "publication", at: new Date().toISOString() }), null]; }
  disconnect() {}
} }));
vi.mock("./db", () => ({ getPool: () => ({ query: fixture.query }), getDatabasePoolSnapshot: () => fixture.poolSnapshot }));
vi.mock("./readiness-probes", () => ({
  probeAiConfiguration: () => true,
  probeDatabaseAndSchema: async () => ({ database: "up", tokenEncryption: "up", schema: { ready: true, reasons: [] } }),
  probeMailDeliveryConfiguration: () => "up",
  probeTrackingSecretsConfiguration: () => "up",
  probeUploadIngressConfiguration: () => "up",
}));
vi.mock("./ai-provider-health", () => ({ aiProviderHealthSnapshot: () => fixture.providers }));

import { loadAdminSystemDiagnostics, probeAdminQueues, runDiagnosticDefinitions } from "./admin-system-diagnostics";

beforeEach(() => {
  vi.stubEnv("REDIS_URL", "redis://localhost:6379/15");
  vi.stubEnv("DATABASE_URL", "postgresql://localhost/aurora_system_test");
  vi.stubEnv("TG_BOT_TOKEN", "");
  fixture.workers = 1; fixture.failed = 0; fixture.paused = false; fixture.completedAt = null;
  fixture.providers = [];
  fixture.query.mockImplementation(async (sql: string) => {
    if (sql.includes("from password_reset_outbox")) return { rows: [{ sent: 1, failed: 0, pending: 0, overdue: 0, last_success_at: "2020-01-01T00:00:00.000Z" }] };
    if (sql.includes("from ai_provider_attempts")) return { rows: [{ provider: "local", model: "fixture", successes: 1, failures: 0, recent_successes: 1, recent_failures: 0, average_latency_ms: 100, last_success_at: new Date(Date.now()-60_000).toISOString(), last_failure_at: null, first_failure_at: null, last_error_code: null }] };
    if (sql.includes("from ai_usage")) return { rows: [{ today: 0, period: 0, timezone: "UTC" }] };
    return { rows: [] };
  });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("system monitoring integrity regressions", () => {
  it("does not mark an idle registered consumer healthy without execution evidence", async () => {
    expect((await probeAdminQueues())[0].state).toBe("unobserved");
  });
  it("preserves retained failures as history after fresh processing recovered", async () => {
    fixture.failed = 12; fixture.completedAt = Date.now();
    const queue = (await probeAdminQueues())[0];
    expect(queue.failed).toBe(12);
    expect(queue.state).toBe("healthy");
    expect(queue.safeErrorCode).toBeNull();
  });
  it("does not claim a paused queue is healthy", async () => {
    fixture.paused = true; fixture.completedAt = Date.now();
    expect((await probeAdminQueues())[0].state).toBe("degraded");
  });
  it("expires execution evidence even while a consumer remains registered", async () => {
    fixture.completedAt = Date.now() - 86_400_000;
    expect((await probeAdminQueues())[0].state).toBe("stale");
  });
  it("separates a failed probe from a confirmed component outage", async () => {
    const [component] = await runDiagnosticDefinitions([{ id: "probe", group: "core", label: "Probe", description: "", run: async () => { throw Error("secret"); } }]);
    expect(component.state).toBe("unavailable");
    expect(JSON.stringify(component)).not.toContain("secret");
  });
  it("does not turn configuration alone into a green platform", async () => {
    const report = await loadAdminSystemDiagnostics({ definitions: [{ id: "configured", group: "core", label: "", description: "", run: async () => ({ state: "configured", evidence: [] }) }] });
    expect(report.state).not.toBe("healthy");
  });
  it("does not carry lifetime pool failures into current health", async () => {
    const report = await loadAdminSystemDiagnostics();
    expect(report.components.find(c => c.id === "postgresql")?.state).toBe("healthy");
  });
  it("does not claim an old mail acceptance proves current delivery", async () => {
    const report = await loadAdminSystemDiagnostics();
    expect(report.components.find(c => c.id === "mail_delivery")?.state).toBe("stale");
  });
  it("does not treat an unused Telegram bot as a broken integration", async () => {
    const report = await loadAdminSystemDiagnostics();
    expect(report.components.find(c => c.id === "telegram_worker")?.state).toBe("not_used");
  });
  it("does not let a closed circuit hide a fresh failed provider probe, and recovers on success", async () => {
    fixture.providers = [{ engine: "local", state: "closed", lastOutcome: "failure", updatedAt: new Date().toISOString(), lastFailureCode: "readiness_probe_failed" }];
    const failed = (await loadAdminSystemDiagnostics()).components.find(c => c.id === "aurora_ai");
    expect(failed).toMatchObject({ state: "degraded", safeErrorCode: "readiness_probe_failed" });
    fixture.providers[0].lastOutcome = "success";
    expect((await loadAdminSystemDiagnostics()).components.find(c => c.id === "aurora_ai")?.state).toBe("healthy");
  });
  it("returns partial evidence when one probe never settles", async () => {
    vi.useFakeTimers();
    const pending = runDiagnosticDefinitions([
      { id: "hung", group: "core", label: "", description: "", run: () => new Promise(() => {}) },
      { id: "ok", group: "core", label: "", description: "", run: async () => ({ state: "healthy", evidence: [] }) },
    ], { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const [hung, ok] = await pending;
    expect(hung).toMatchObject({ state: "unavailable", safeErrorCode: "hung_check_timeout", durationMs: 100 });
    expect(ok.state).toBe("healthy");
    expect(Date.parse(ok.checkedAt)).toBeLessThan(Date.parse(hung.checkedAt));
  });
});
