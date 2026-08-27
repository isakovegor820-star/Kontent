import { describe, expect, it, vi } from "vitest";

import { runDeploymentSmoke } from "../scripts/deployment-smoke.mjs";

const NONCE = "YXVyb3JhLWRlcGxveW1lbnQtbm9uY2U=";
const READINESS_TOKEN = "deployment-smoke-test-readiness-token";
const SECURITY_HEADERS = {
  "cache-control": "private, no-cache, no-store, max-age=0, must-revalidate",
  "content-security-policy": [
    "default-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${NONCE}'`,
  ].join("; "),
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function htmlResponse({ nonce = NONCE, headers = {} } = {}) {
  return new Response(
    `<html><head><style nonce="${nonce}">body{color:black}</style></head>`
      + `<body><script nonce="${nonce}">self.__next_f=[]</script></body></html>`,
    { status: 200, headers: { ...SECURITY_HEADERS, ...headers } },
  );
}

function readyReport(overrides = {}) {
  return {
    status: "ready",
    schemaReady: true,
    webReady: true,
    publicationReady: true,
    aiReady: true,
    mailDeliveryReady: true,
    uploadReady: true,
    tokenEncryptionReady: true,
    trackingReady: true,
    passwordRecoveryReady: true,
    checkedAt: "2026-08-17T12:00:00.000Z",
    ...overrides,
  };
}

function successfulFetch(readiness = readyReport()) {
  return vi.fn(async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/health") return jsonResponse({ ok: true, status: "alive" });
    if (path === "/api/readiness") return jsonResponse(readiness);
    return htmlResponse();
  });
}

describe("deployment smoke", () => {
  it("verifies full readiness and nonce-bound production HTML", async () => {
    const fetchImpl = successfulFetch();
    const logger = { log: vi.fn() };
    await expect(runDeploymentSmoke({
      env: {
        AURORA_DEPLOYMENT_SMOKE_BASE_URL: "https://aurora.example",
        AURORA_READINESS_TOKEN: READINESS_TOKEN,
      },
      fetchImpl,
      logger,
      now: new Date("2026-08-17T12:01:00.000Z"),
    })).resolves.toMatchObject({
      ok: true,
      host: "aurora.example",
      profile: "full",
      readinessStatus: "ready",
      checkedPages: ["/", "/login"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    for (const [, options] of fetchImpl.mock.calls) {
      expect(options).toMatchObject({ method: "GET", redirect: "manual" });
    }
    const readinessCall = fetchImpl.mock.calls.find(([url]) => new URL(url).pathname === "/api/readiness");
    expect(new Headers(readinessCall?.[1]?.headers).get("authorization"))
      .toBe(`Bearer ${READINESS_TOKEN}`);
  });

  it.each([
    ["http://aurora.example", "deployment_smoke_requires_https"],
    ["https://user:secret@aurora.example", "deployment_smoke_url_contains_credentials_or_metadata"],
    ["https://127.0.0.1", "deployment_smoke_target_not_public_origin"],
    ["https://[::1]", "deployment_smoke_target_not_public_origin"],
    ["https://service.local", "deployment_smoke_target_not_public_origin"],
  ])("rejects an unsafe target %s", async (target, code) => {
    const fetchImpl = vi.fn();
    await expect(runDeploymentSmoke({
      env: { AURORA_DEPLOYMENT_SMOKE_BASE_URL: target },
      fetchImpl,
    })).rejects.toMatchObject({ code });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails full smoke when any production capability is degraded", async () => {
    await expect(runDeploymentSmoke({
      env: {
        AURORA_DEPLOYMENT_SMOKE_BASE_URL: "https://aurora.example",
        AURORA_READINESS_TOKEN: READINESS_TOKEN,
      },
      fetchImpl: successfulFetch(readyReport({
        status: "degraded",
        publicationReady: false,
        passwordRecoveryReady: false,
      })),
      now: new Date("2026-08-17T12:01:00.000Z"),
    })).rejects.toMatchObject({
      code: "deployment_smoke_readiness_failed",
      details: { failedCapabilities: ["publicationReady", "passwordRecoveryReady"] },
    });
  });

  it("allows a deliberately scoped web-only smoke without hiding the profile", async () => {
    await expect(runDeploymentSmoke({
      env: {
        AURORA_DEPLOYMENT_SMOKE_BASE_URL: "https://aurora.example",
        AURORA_DEPLOYMENT_SMOKE_PROFILE: "web",
        AURORA_READINESS_TOKEN: READINESS_TOKEN,
      },
      fetchImpl: successfulFetch(readyReport({ status: "degraded", publicationReady: false })),
      logger: { log: vi.fn() },
      now: new Date("2026-08-17T12:01:00.000Z"),
    })).resolves.toMatchObject({ profile: "web", readinessStatus: "degraded" });
  });

  it("allows an explicit release smoke when only mail and password recovery are degraded", async () => {
    await expect(runDeploymentSmoke({
      env: {
        AURORA_DEPLOYMENT_SMOKE_BASE_URL: "https://aurora.example",
        AURORA_DEPLOYMENT_SMOKE_PROFILE: "release",
        AURORA_READINESS_TOKEN: READINESS_TOKEN,
      },
      fetchImpl: successfulFetch(readyReport({
        status: "degraded",
        mailDeliveryReady: false,
        passwordRecoveryReady: false,
      })),
      logger: { log: vi.fn() },
      now: new Date("2026-08-17T12:01:00.000Z"),
    })).resolves.toMatchObject({ profile: "release", readinessStatus: "degraded" });
  });

  it("accepts only target-known forward schema drift during the explicit pre-deploy check", async () => {
    const migrationReason = "migration_unexpected:20260920_session_token_expand_compat.sql";
    const readiness = readyReport({
      status: "not_ready",
      processAlive: true,
      databaseReady: true,
      schemaReady: false,
      webReady: false,
      publicationReady: false,
      aiReady: false,
      tokenEncryptionReady: false,
      mailDeliveryReady: false,
      passwordRecoveryReady: false,
      reasons: [
        migrationReason,
        "publication_worker_unavailable",
        "telegram_polling_unavailable",
        "ai_unobserved",
        "mail_delivery_not_configured",
      ],
      checks: {
        database: "up",
        schema: { ready: false, reasons: [migrationReason] },
        redis: "up",
        publicationWorker: "down",
        telegramPolling: "down",
        aiProviders: [],
        aiConfigured: true,
        mailDelivery: "not_configured",
        uploadIngress: "up",
        tokenEncryption: "down",
        trackingSecrets: "up",
      },
    });
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/health") return jsonResponse({ ok: true, status: "alive" });
      if (path === "/api/readiness") return jsonResponse(readiness, { status: 503 });
      return htmlResponse();
    });

    await expect(runDeploymentSmoke({
      env: {
        AURORA_DEPLOYMENT_SMOKE_BASE_URL: "https://aurora.example",
        AURORA_DEPLOYMENT_SMOKE_PROFILE: "release",
        AURORA_READINESS_TOKEN: READINESS_TOKEN,
      },
      fetchImpl,
      now: new Date("2026-08-17T12:01:00.000Z"),
    })).rejects.toMatchObject({
      code: "deployment_smoke_http_failure",
      details: {
        surface: "readiness",
        status: 503,
        readiness: {
          status: "not_ready",
          databaseReady: true,
          schemaReady: false,
          webReady: false,
          uploadReady: true,
          reasons: [
            migrationReason,
            "publication_worker_unavailable",
            "telegram_polling_unavailable",
            "ai_unobserved",
            "mail_delivery_not_configured",
          ],
          checks: {
            database: "up",
            schemaReady: false,
            schemaReasons: [migrationReason],
            uploadIngress: "up",
          },
        },
      },
    });

    await expect(runDeploymentSmoke({
      env: {
        AURORA_DEPLOYMENT_SMOKE_BASE_URL: "https://aurora.example",
        AURORA_DEPLOYMENT_SMOKE_PROFILE: "release",
        AURORA_DEPLOYMENT_SMOKE_ALLOW_FORWARD_SCHEMA: "true",
        AURORA_READINESS_TOKEN: READINESS_TOKEN,
      },
      fetchImpl,
      logger: { log: vi.fn() },
      now: new Date("2026-08-17T12:01:00.000Z"),
    })).resolves.toMatchObject({
      profile: "release",
      readinessStatus: "forward_compatible",
    });

    readiness.reasons[0] = "migration_unexpected:20990101_unknown.sql";
    readiness.checks.schema.reasons[0] = "migration_unexpected:20990101_unknown.sql";
    await expect(runDeploymentSmoke({
      env: {
        AURORA_DEPLOYMENT_SMOKE_BASE_URL: "https://aurora.example",
        AURORA_DEPLOYMENT_SMOKE_PROFILE: "release",
        AURORA_DEPLOYMENT_SMOKE_ALLOW_FORWARD_SCHEMA: "true",
        AURORA_READINESS_TOKEN: READINESS_TOKEN,
      },
      fetchImpl,
      now: new Date("2026-08-17T12:01:00.000Z"),
    })).rejects.toMatchObject({ code: "deployment_smoke_forward_schema_unverified" });
  });

  it("keeps every non-mail production capability mandatory for release smoke", async () => {
    await expect(runDeploymentSmoke({
      env: {
        AURORA_DEPLOYMENT_SMOKE_BASE_URL: "https://aurora.example",
        AURORA_DEPLOYMENT_SMOKE_PROFILE: "release",
        AURORA_READINESS_TOKEN: READINESS_TOKEN,
      },
      fetchImpl: successfulFetch(readyReport({
        status: "degraded",
        publicationReady: false,
        mailDeliveryReady: false,
        passwordRecoveryReady: false,
      })),
      now: new Date("2026-08-17T12:01:00.000Z"),
    })).rejects.toMatchObject({
      code: "deployment_smoke_readiness_failed",
      details: { failedCapabilities: ["publicationReady"] },
    });
  });

  it("rejects stale readiness reports", async () => {
    await expect(runDeploymentSmoke({
      env: {
        AURORA_DEPLOYMENT_SMOKE_BASE_URL: "https://aurora.example",
        AURORA_READINESS_TOKEN: READINESS_TOKEN,
      },
      fetchImpl: successfulFetch(readyReport({ checkedAt: "2026-08-17T11:00:00.000Z" })),
      now: new Date("2026-08-17T12:01:00.000Z"),
    })).rejects.toMatchObject({ code: "deployment_smoke_readiness_stale" });
  });

  it("rejects HTML when framework scripts are not bound to the CSP nonce", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/health") return jsonResponse({ ok: true, status: "alive" });
      if (path === "/api/readiness") return jsonResponse(readyReport());
      return htmlResponse({ nonce: "different-nonce" });
    });
    await expect(runDeploymentSmoke({
      env: {
        AURORA_DEPLOYMENT_SMOKE_BASE_URL: "https://aurora.example",
        AURORA_READINESS_TOKEN: READINESS_TOKEN,
      },
      fetchImpl,
      now: new Date("2026-08-17T12:01:00.000Z"),
    })).rejects.toMatchObject({ code: "deployment_smoke_nonce_binding_failed" });
  });

  it("rejects redirects instead of following the deployment to another origin", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://unexpected.example" },
    }));
    await expect(runDeploymentSmoke({
      env: {
        AURORA_DEPLOYMENT_SMOKE_BASE_URL: "https://aurora.example",
        AURORA_READINESS_TOKEN: READINESS_TOKEN,
      },
      fetchImpl,
    })).rejects.toMatchObject({ code: "deployment_smoke_unexpected_redirect" });
  });
});
