import { describe, expect, it, vi } from "vitest";

import {
  createLegalProviderAdapter,
  LegalProviderError,
  loadLegalProviderRegistry,
  normalizeLegalFragments,
  normalizeLegalProviderConfig,
  publicLegalProvider,
} from "./legal-provider-adapter.mjs";

const rawProvider = {
  id: "vendor-law",
  label: "Vendor Law",
  kind: "official_api",
  baseUrl: "https://api.vendor.example/",
  endpoints: {
    connect: "/v1/connect",
    validate: "/v1/validate",
    sync: "/v1/sync",
    health: "/v1/health",
    disconnect: "/v1/disconnect",
  },
  idempotencyHeader: "Idempotency-Key",
  licenseConfirmed: true,
};

describe("legal provider registry", () => {
  it("is empty when no official vendor endpoints are configured", () => {
    expect(loadLegalProviderRegistry("")).toEqual([]);
  });

  it("requires an explicit license confirmation and same-origin HTTPS endpoints", () => {
    expect(() => normalizeLegalProviderConfig({ ...rawProvider, licenseConfirmed: false }))
      .toThrow(expect.objectContaining({ code: "license_not_confirmed" }));
    expect(() => normalizeLegalProviderConfig({
      ...rawProvider,
      endpoints: { ...rawProvider.endpoints, sync: "https://other.example/sync" },
    })).toThrow(expect.objectContaining({ code: "invalid_provider_config" }));
    expect(() => normalizeLegalProviderConfig({ ...rawProvider, baseUrl: "http://localhost:9000" }))
      .toThrow(expect.objectContaining({ code: "invalid_provider_config" }));
  });

  it("exposes only non-secret provider metadata to the browser", () => {
    const provider = normalizeLegalProviderConfig(rawProvider);
    expect(publicLegalProvider(provider)).toEqual(expect.objectContaining({
      id: "vendor-law",
      kind: "official_api",
      capabilities: expect.arrayContaining(["connect", "sync", "disconnect"]),
    }));
    expect(publicLegalProvider(provider)).not.toHaveProperty("baseUrl");
    expect(publicLegalProvider(provider)).not.toHaveProperty("endpoints");
  });
});

describe("legal provider adapter", () => {
  it("uses a stable vendor idempotency key and never returns the token", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      accountLabel: "Редакция",
      subscriptionStatus: "active",
      tokenExpiresAt: "2026-12-01T00:00:00Z",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const adapter = createLegalProviderAdapter(normalizeLegalProviderConfig(rawProvider), { fetchImpl });
    const result = await adapter.connect({ token: "secret-api-token", idempotencyKey: "legal-connect:12345678" });

    expect(fetchImpl).toHaveBeenCalledWith("https://api.vendor.example/v1/connect", expect.objectContaining({
      method: "POST",
      redirect: "error",
      headers: expect.objectContaining({
        authorization: "Bearer secret-api-token",
        "Idempotency-Key": "legal-connect:12345678",
      }),
    }));
    expect(result).toEqual({
      accountLabel: "Редакция",
      subscriptionStatus: "active",
      tokenExpiresAt: "2026-12-01T00:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("secret-api-token");
  });

  it("rejects a paid mutation without an idempotency key", async () => {
    const adapter = createLegalProviderAdapter(normalizeLegalProviderConfig(rawProvider), { fetchImpl: vi.fn() });
    await expect(adapter.sync({ token: "token", cursor: null }))
      .rejects.toMatchObject({ code: "idempotency_key_required" });
  });

  it("maps provider rate limiting without including the provider response body", async () => {
    const adapter = createLegalProviderAdapter(normalizeLegalProviderConfig(rawProvider), {
      fetchImpl: vi.fn(async () => new Response("sensitive vendor diagnostics", { status: 429 })),
    });
    await expect(adapter.sync({ token: "token", idempotencyKey: "legal-sync:12345678" }))
      .rejects.toMatchObject({ code: "provider_rate_limited", retryable: true });
  });

  it("never follows redirects with a bearer token and keeps one key across a timeout retry", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new DOMException("timed out", "TimeoutError"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        healthy: true,
        subscriptionStatus: "active",
      }), { status: 200 }));
    const adapter = createLegalProviderAdapter(normalizeLegalProviderConfig(rawProvider), { fetchImpl });
    const input = { token: "secret-api-token", idempotencyKey: "legal-health:12345678" };

    await expect(adapter.health(input)).rejects.toMatchObject({ code: "provider_timeout", retryable: true });
    await expect(adapter.health(input)).resolves.toMatchObject({ healthy: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options).toEqual(expect.objectContaining({
        method: "GET",
        redirect: "error",
        headers: expect.objectContaining({
          authorization: "Bearer secret-api-token",
          "Idempotency-Key": "legal-health:12345678",
        }),
      }));
    }
  });
});

describe("legal fragment provenance", () => {
  it("keeps law, case, commentary and document records separate with provenance on every fragment", () => {
    const records = normalizeLegalFragments([
      {
        externalId: "law-1",
        type: "law",
        title: "Федеральный закон",
        source: "Официальный источник",
        date: "2026-08-01T00:00:00Z",
        currentness: "current",
        url: "https://vendor.example/law/1",
        fragments: [{ text: "Фрагмент 1" }, { text: "Фрагмент 2" }],
      },
      {
        externalId: "case-1",
        type: "case",
        title: "Судебное дело",
        source: "Картотека",
        date: "2026-07-20T00:00:00Z",
        currentness: "unknown",
        url: "https://vendor.example/case/1",
        content: "Решение",
      },
    ]);

    expect(records.map((record) => record.legalType)).toEqual(["law", "case"]);
    expect(records[0].fragments).toHaveLength(2);
    expect(records[0].fragments[0]).toEqual(expect.objectContaining({
      sourceName: "Официальный источник",
      sourceDate: "2026-08-01T00:00:00.000Z",
      currentness: "current",
      sourceUrl: "https://vendor.example/law/1",
    }));
  });

  it.each([
    [{ externalId: "x", type: "secret", source: "S", date: "2026-01-01", currentness: "current", url: "https://x.example", content: "x" }, "invalid_legal_type"],
    [{ externalId: "x", type: "law", source: "S", currentness: "current", url: "https://x.example", content: "x" }, "invalid_provenance"],
    [{ externalId: "x", type: "law", source: "S", date: "2026-01-01", currentness: "current", url: "http://x.example", content: "x" }, "invalid_provenance"],
  ])("rejects records without licensed legal provenance", (record, code) => {
    expect(() => normalizeLegalFragments([record])).toThrow(expect.objectContaining({ code }));
  });

  it("uses typed errors without recording sensitive bodies", () => {
    const error = new LegalProviderError("provider_unavailable", "Провайдер недоступен", { retryable: true });
    expect(error).toMatchObject({ name: "LegalProviderError", retryable: true });
  });
});
