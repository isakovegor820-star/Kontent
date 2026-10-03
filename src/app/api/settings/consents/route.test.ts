import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  poolQuery: vi.fn(),
  session: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  getPool: () => ({ query: mocks.poolQuery, connect: mocks.connect }),
}));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.rateLimit,
  clientIp: () => "203.0.113.7",
  rateLimitResponse: () => Response.json({ ok: false, error: "rate_limited" }, { status: 429 }),
}));

import { GET, POST } from "./route";

const user = { id: 42, email: "user@example.test", name: "Пользователь" };

function withOrigin(path = "/api/settings/consents") {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
      host: "localhost",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ kind: "pd_processing" }),
  });
}

describe("settings consents route", () => {
  beforeEach(() => {
    mocks.session.mockResolvedValue(user);
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.poolQuery.mockResolvedValue({ rows: [] });
    mocks.connect.mockResolvedValue({
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes("granted_at desc, id desc")) {
          return {
            rows: [
              {
                kind: "pd_processing",
                granted: true,
                granted_at: new Date("2026-10-02T18:00:00.000Z"),
                consent_text_version: "draft-2026-10",
                policy_version: "2026-08-24",
                source: "register",
              },
            ],
          };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    });
  });
  afterEach(() => vi.clearAllMocks());

  it("returns the current state and the history", async () => {
    mocks.poolQuery.mockResolvedValue({
      rows: [
        {
          kind: "pd_processing",
          granted: true,
          granted_at: new Date("2026-10-02T18:00:00.000Z"),
          consent_text_version: "draft-2026-10",
          policy_version: "2026-08-24",
          source: "register",
          ip: "203.0.113.7",
          user_agent: "vitest",
        },
      ],
    });

    const response = await GET(new NextRequest("http://localhost/api/settings/consents"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.current).toHaveLength(4);
    expect(body.current[0]).toMatchObject({ kind: "pd_processing", granted: true });
    expect(body.history[0]).toMatchObject({ hasIp: true });
    // Обязательность согласия отдаём интерфейсу, чтобы он показывал статус честно.
    expect(typeof body.required).toBe("boolean");
  });

  it("requires a session for reading", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/settings/consents"));
    expect(response.status).toBe(401);
  });

  it("rejects a mutation from a foreign origin before any work", async () => {
    const request = new NextRequest("http://localhost/api/settings/consents", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ kind: "pd_processing" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects an unknown consent kind", async () => {
    const request = new NextRequest("http://localhost/api/settings/consents", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "http://localhost",
        host: "localhost",
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ kind: "рассылки" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "bad_kind" });
  });

  it("revokes inside a transaction with an advisory lock", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes("granted_at desc, id desc")) {
          return {
            rows: [
              {
                kind: "pd_processing",
                granted: true,
                granted_at: new Date("2026-10-02T18:00:00.000Z"),
                consent_text_version: "draft-2026-10",
                policy_version: "2026-08-24",
                source: "register",
              },
            ],
          };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValue(client);

    const response = await POST(withOrigin());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, revoked: true });

    const statements = client.query.mock.calls.map(([sql]: [string]) => String(sql));
    // Лок обязателен: два одновременных запроса иначе создадут два отзыва.
    expect(statements.some((sql) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(statements.some((sql) => sql.includes("insert into consents"))).toBe(true);
    expect(statements).toContain("commit");
    expect(client.release).toHaveBeenCalled();
  });

  it("answers 409 when there is nothing to revoke", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (String(sql).includes("granted_at desc, id desc")) return { rows: [] };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    mocks.connect.mockResolvedValue(client);

    const response = await POST(withOrigin());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "not_granted" });
    const statements = client.query.mock.calls.map(([sql]: [string]) => String(sql));
    expect(statements).toContain("rollback");
  });
});
