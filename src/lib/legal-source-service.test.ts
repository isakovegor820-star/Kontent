import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeLegalProviderConfig } from "./legal-provider-adapter.mjs";
import { connectLegalSource, runLegalSourceAction } from "./legal-source-service";
import { encryptToken } from "./token-crypto.mjs";

const provider = normalizeLegalProviderConfig({
  id: "vendor-law",
  label: "Vendor Law",
  kind: "official_api",
  baseUrl: "https://api.vendor.example/",
  endpoints: {
    connect: "/connect",
    validate: "/validate",
    sync: "/sync",
    health: "/health",
    disconnect: "/disconnect",
  },
  licenseConfirmed: true,
});

type Operation = {
  id: number;
  request_fingerprint: string;
  status: "dispatching" | "succeeded" | "failed";
  lease_token: string | null;
  lease_expires_at: Date | null;
  result_payload: Record<string, unknown> | null;
  http_status: number | null;
};

function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11",
    provider_id: "vendor-law",
    provider_label: "Vendor Law",
    integration_kind: "official_api",
    status: "connected",
    subscription_status: "active",
    external_account_label: "Редакция",
    token_expires_at: "2026-12-01T00:00:00Z",
    last_sync_at: null,
    last_health_at: null,
    last_error_code: null,
    last_error_message: null,
    created_at: "2026-08-05T00:00:00Z",
    updated_at: "2026-08-05T00:00:00Z",
    token_envelope: null,
    sync_cursor: null,
    ...overrides,
  };
}

function fakePool(initialConnection?: ReturnType<typeof connectionRow>) {
  const operations = new Map<string, Operation>();
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  let currentConnection = initialConnection ?? null;
  let nextOperationId = 1;

  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: null };
    if (sql.includes("insert into legal_source_operations")) {
      const key = String(values[4]);
      if (operations.has(key)) return { rows: [], rowCount: 0 };
      const operation: Operation = {
        id: nextOperationId++,
        request_fingerprint: String(values[5]),
        status: "dispatching",
        lease_token: String(values[6]),
        lease_expires_at: new Date(Date.now() + 90_000),
        result_payload: null,
        http_status: null,
      };
      operations.set(key, operation);
      return { rows: [operation], rowCount: 1 };
    }
    if (sql.includes("from legal_source_operations") && sql.includes("request_key")) {
      const operation = operations.get(String(values[1]));
      return { rows: operation ? [operation] : [], rowCount: operation ? 1 : 0 };
    }
    if (sql.includes("set lease_token = $3")) {
      const operation = operations.get(String(values[1]));
      if (!operation || !operation.lease_expires_at || operation.lease_expires_at.getTime() > Date.now()) {
        return { rows: [], rowCount: 0 };
      }
      operation.lease_token = String(values[2]);
      operation.lease_expires_at = new Date(Date.now() + 90_000);
      return { rows: [{ id: operation.id }], rowCount: 1 };
    }
    if (sql.includes("set status = $3, result_payload")) {
      const operation = [...operations.values()].find((candidate) => candidate.id === Number(values[0]));
      if (!operation || operation.lease_token !== values[1]) return { rows: [], rowCount: 0 };
      operation.status = values[2] as Operation["status"];
      operation.result_payload = JSON.parse(String(values[3]));
      operation.http_status = Number(values[4]);
      operation.lease_token = null;
      operation.lease_expires_at = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("set connection_id = $3")) return { rows: [], rowCount: 1 };
    if (sql.includes("set lease_expires_at = now()")) {
      const operation = [...operations.values()].find((candidate) => candidate.id === Number(values[0]));
      if (operation) operation.lease_expires_at = new Date(0);
      return { rows: [], rowCount: operation ? 1 : 0 };
    }
    if (sql.includes("insert into legal_source_connections")) {
      currentConnection = connectionRow({
        provider_id: values[1],
        provider_label: values[2],
        integration_kind: values[3],
        token_envelope: values[4],
        subscription_status: values[5],
        external_account_label: values[6],
        token_expires_at: values[7],
      });
      return { rows: [currentConnection], rowCount: 1 };
    }
    if (sql.includes("from legal_source_connections") && sql.includes("where id = $1")) {
      return { rows: currentConnection ? [currentConnection] : [], rowCount: currentConnection ? 1 : 0 };
    }
    if (sql.includes("insert into legal_source_fragments")) return { rows: [], rowCount: 1 };
    if (sql.includes("update legal_source_connections")) {
      if (sql.includes("set token_envelope = null") && currentConnection) {
        currentConnection = connectionRow({ ...currentConnection, token_envelope: null, status: "disconnected" });
      }
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
  const client = { query, release: vi.fn() };
  return {
    pool: { query, connect: vi.fn(async () => client) },
    calls,
    operations,
    get connection() { return currentConnection; },
    client,
  };
}

function adapter(overrides: Record<string, unknown> = {}) {
  return {
    connect: vi.fn(async () => ({
      accountLabel: "Редакция",
      subscriptionStatus: "active",
      tokenExpiresAt: "2026-12-01T00:00:00.000Z",
    })),
    validate: vi.fn(async () => ({ valid: true, subscriptionStatus: "active", tokenExpiresAt: null })),
    sync: vi.fn(async () => ({ cursor: null, fragments: [] })),
    health: vi.fn(async () => ({ healthy: true, subscriptionStatus: "active", tokenExpiresAt: null, message: null })),
    disconnect: vi.fn(async () => ({ disconnected: true as const })),
    ...overrides,
  };
}

describe("legal source service", () => {
  const previousKey = process.env.TOKENS_MASTER_KEY;

  beforeEach(() => {
    process.env.TOKENS_MASTER_KEY = "legal-source-test-master-key";
  });

  afterEach(() => {
    if (previousKey == null) delete process.env.TOKENS_MASTER_KEY;
    else process.env.TOKENS_MASTER_KEY = previousKey;
  });

  it("encrypts the token and replays the durable connect result without a second vendor call", async () => {
    const database = fakePool();
    const providerAdapter = adapter();
    const options = { registry: [provider], adapterFactory: vi.fn(() => providerAdapter) };
    const input = {
      userId: 7,
      requestKey: "legal-connect:12345678",
      providerId: "vendor-law",
      token: "official-secret-token",
    };

    const first = await connectLegalSource(database.pool as never, input, options as never);
    const replay = await connectLegalSource(database.pool as never, input, options as never);

    expect(first).toMatchObject({ status: 201, body: { ok: true, connection: { providerId: "vendor-law" } } });
    expect(replay).toMatchObject({ status: 201, body: { ok: true, replayed: true }, replayed: true });
    expect(providerAdapter.connect).toHaveBeenCalledOnce();
    expect(database.connection?.token_envelope).toMatch(/^v1:/);
    expect(database.connection?.token_envelope).not.toContain("official-secret-token");
    expect(JSON.stringify(first.body)).not.toContain("official-secret-token");
  });

  it("persists every synced fragment with explicit type and provenance", async () => {
    const encrypted = encryptToken("official-secret-token", { userId: 7, provider: "legal:vendor-law" });
    const database = fakePool(connectionRow({ token_envelope: encrypted, sync_cursor: "cursor-1" }));
    const providerAdapter = adapter({
      sync: vi.fn(async () => ({
        cursor: "cursor-2",
        fragments: [{
          externalId: "law-42",
          legalType: "law",
          title: "Нормативный акт",
          sourceName: "Официальный источник",
          sourceDate: "2026-08-01T00:00:00.000Z",
          currentness: "current",
          sourceUrl: "https://vendor.example/law/42",
          relevantAt: "2026-08-05T00:00:00.000Z",
          fragments: [
            { fragmentIndex: 0, text: "Часть 1", sourceName: "Официальный источник", sourceDate: "2026-08-01T00:00:00.000Z", currentness: "current", sourceUrl: "https://vendor.example/law/42" },
            { fragmentIndex: 1, text: "Часть 2", sourceName: "Официальный источник", sourceDate: "2026-08-01T00:00:00.000Z", currentness: "current", sourceUrl: "https://vendor.example/law/42" },
          ],
        }],
      })),
    });

    const result = await runLegalSourceAction(database.pool as never, {
      userId: 7,
      connectionId: 11,
      requestKey: "legal-sync:12345678",
      action: "sync",
    }, { registry: [provider], adapterFactory: vi.fn(() => providerAdapter) } as never);

    expect(result).toMatchObject({ status: 200, body: { ok: true, action: "sync", fragmentCount: 2 } });
    expect(providerAdapter.sync).toHaveBeenCalledWith({
      token: "official-secret-token",
      cursor: "cursor-1",
      idempotencyKey: "legal-sync:12345678",
    });
    const fragmentWrites = database.calls.filter((call) => call.sql.includes("insert into legal_source_fragments"));
    expect(fragmentWrites).toHaveLength(2);
    expect(fragmentWrites[0].values).toEqual(expect.arrayContaining([
      "law",
      "Официальный источник",
      "2026-08-01T00:00:00.000Z",
      "current",
      "https://vendor.example/law/42",
    ]));
  });

  it("replays a completed disconnect after the encrypted token has been removed", async () => {
    const encrypted = encryptToken("official-secret-token", { userId: 7, provider: "legal:vendor-law" });
    const database = fakePool(connectionRow({ token_envelope: encrypted }));
    const providerAdapter = adapter();
    const input = {
      userId: 7,
      connectionId: 11,
      requestKey: "legal-disconnect:12345678",
      action: "disconnect" as const,
    };

    const first = await runLegalSourceAction(database.pool as never, input, {
      registry: [provider],
      adapterFactory: vi.fn(() => providerAdapter),
    } as never);
    expect(database.connection?.token_envelope).toBeNull();
    const replay = await runLegalSourceAction(database.pool as never, input, { registry: [] } as never);

    expect(first).toMatchObject({ status: 200, body: { ok: true, disconnected: true } });
    expect(replay).toMatchObject({ status: 200, body: { ok: true, disconnected: true, replayed: true }, replayed: true });
    expect(providerAdapter.disconnect).toHaveBeenCalledOnce();
  });

  it("retries a timeout with the same provider idempotency key", async () => {
    const encrypted = encryptToken("official-secret-token", { userId: 7, provider: "legal:vendor-law" });
    const database = fakePool(connectionRow({ token_envelope: encrypted }));
    const timeout = Object.assign(new Error("Провайдер не ответил вовремя"), {
      code: "provider_timeout",
      retryable: true,
      status: 503,
    });
    const health = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({ healthy: true, subscriptionStatus: "active", tokenExpiresAt: null, message: null });
    const providerAdapter = adapter({ health });
    const input = {
      userId: 7,
      connectionId: 11,
      requestKey: "legal-health:12345678",
      action: "health" as const,
    };
    const options = { registry: [provider], adapterFactory: vi.fn(() => providerAdapter) } as never;

    const timedOut = await runLegalSourceAction(database.pool as never, input, options);
    const retried = await runLegalSourceAction(database.pool as never, input, options);

    expect(timedOut).toMatchObject({ status: 503, body: { error: "provider_timeout", retryable: true } });
    expect(retried).toMatchObject({ status: 200, body: { ok: true, action: "health", healthy: true } });
    expect(health).toHaveBeenNthCalledWith(1, {
      token: "official-secret-token",
      idempotencyKey: "legal-health:12345678",
    });
    expect(health).toHaveBeenNthCalledWith(2, {
      token: "official-secret-token",
      idempotencyKey: "legal-health:12345678",
    });
  });
});
