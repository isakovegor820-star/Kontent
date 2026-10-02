import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  rateLimit: vi.fn(),
  notifyOwner: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/notify", () => ({ notifyOwner: mocks.notifyOwner, nowMoscow: () => "02.10.2026, 21:00" }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.rateLimit,
  clientIp: () => "203.0.113.7",
  rateLimitResponse: () => Response.json({ error: "rate_limited" }, { status: 429 }),
}));

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/lead", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "vitest-lead" },
    body: JSON.stringify(body),
  });
}

/** Запросы к базе: заявка и запись согласия идут разными вызовами. */
function queryCalls() {
  return mocks.query.mock.calls as Array<[string, unknown[]]>;
}
function leadInsertCalls() {
  return queryCalls().filter(([sql]) => String(sql).includes("insert into leads"));
}
function consentInsertCalls() {
  return queryCalls().filter(([sql]) => String(sql).includes("insert into consents"));
}

describe("lead route consent handling", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://local/test";
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.query.mockResolvedValue({ rowCount: 1, rows: [{ id: 1 }] });
    mocks.notifyOwner.mockResolvedValue(undefined);
  });
  afterEach(() => vi.clearAllMocks());

  it("accepts a lead without consent while the texts are not approved", async () => {
    const response = await POST(request({ contact: "test@example.com", source: "v3_final_waitlist" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, duplicate: false });
    // Заявка записана, но согласие не выдумано: колонки остаются пустыми.
    const [sql, values] = leadInsertCalls()[0];
    expect(sql).toContain("consent_granted");
    expect(values[4]).toBeNull();
    expect(values[5]).toBeNull();
    expect(values[6]).toBeNull();
    expect(consentInsertCalls()).toHaveLength(0);
  });

  it("stores the evidence row when the form sends consent", async () => {
    const response = await POST(request({ contact: "test@example.com", consent: true }));

    expect(response.status).toBe(200);
    const [sql, values] = leadInsertCalls()[0];
    expect(sql).toContain("consent_text_version");
    expect(values[4]).toBe(true);
    expect(typeof values[5]).toBe("string");
    expect(values[6]).toBeInstanceOf(Date);

    // Отдельная запись в журнале согласий: доказательство с адресом и клиентом.
    const [consentSql, consentValues] = consentInsertCalls()[0];
    expect(consentSql).toContain("insert into consents");
    expect(consentValues).toContain("test@example.com");
    expect(consentValues).toContain("203.0.113.7");
    expect(consentValues).toContain("vitest-lead");
    expect(consentValues).toContain("lead");
  });

  it("rejects a look-alike consent value instead of treating it as agreement", async () => {
    const response = await POST(request({ contact: "test@example.com", consent: "true" }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "consent_required" });
    expect(leadInsertCalls()).toHaveLength(0);
    expect(mocks.notifyOwner).not.toHaveBeenCalled();
  });

  it("keeps the honeypot silent and writes nothing to the database", async () => {
    const response = await POST(request({ contact: "bot@example.com", website: "http://spam" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, duplicate: false });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("reports a duplicate without losing the consent record", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("insert into leads")) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    const response = await POST(request({ contact: "test@example.com", consent: true }));

    await expect(response.json()).resolves.toEqual({ ok: true, duplicate: true });
    expect(consentInsertCalls()).toHaveLength(1);
  });
});
