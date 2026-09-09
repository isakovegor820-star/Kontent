import { describe, expect, it, vi } from "vitest";

import {
  adminAlertRecipients,
  adminAlertsConfig,
  sendAdminAlertMessage,
  evaluateAdminAlertConditions,
  formatAdminAlertMessage,
} from "./admin-alerts";

describe("admin alert conditions", () => {
  it("derives conditions from the readiness probe and the overdue count independently", async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 1, rows: [{ overdue: "7" }] })) };
    const probe = vi.fn(async () => ({ redis: "up" as const, publicationWorker: "down" as const, telegramPolling: "conflict" as const }));
    const conditions = await evaluateAdminAlertConditions({ pool: pool as never, overdueThreshold: 5, probe });
    expect(Object.fromEntries(conditions.map((item) => [item.id, item.firing]))).toEqual({
      database: false, overdue_publications: true, redis: false, publication_worker: true, telegram_worker: true,
    });
    expect(conditions.find((item) => item.id === "telegram_worker")?.severity).toBe("critical");
  });

  it("reports the database as down when the query fails but still evaluates Redis", async () => {
    const pool = { query: vi.fn(async () => { throw new Error("postgresql://secret@host"); }) };
    const probe = vi.fn(async () => ({ redis: "down" as const, publicationWorker: "down" as const, telegramPolling: "not_configured" as const }));
    const conditions = await evaluateAdminAlertConditions({ pool: pool as never, overdueThreshold: 5, probe });
    expect(conditions.map((item) => [item.id, item.firing])).toEqual([["database", true], ["redis", true], ["publication_worker", false]]);
    expect(JSON.stringify(conditions)).not.toContain("secret");
  });
});

describe("admin alert delivery", () => {
  it("does not treat malformed HTTP200 as a confirmed Telegram receipt", async () => {
    expect(await sendAdminAlertMessage({ token: "123:isolated", chatId: "555", text: "down", fetchImpl: async () => Response.json({}) })).toEqual({ kind: "unknown" });
  });
  it("requires a real message ID and distinguishes explicit rejection from lost confirmation", async () => {
    const send = (response: Response) => sendAdminAlertMessage({ token: "123:isolated", chatId: "555", text: "down", fetchImpl: async () => response });
    expect(await send(Response.json({ ok: true, result: { message_id: 81 } }))).toMatchObject({ kind: "accepted", messageIds: [81] });
    expect(await send(Response.json({ ok: true, result: {} }))).toEqual({ kind: "unknown" });
    expect(await send(Response.json({ ok: false, error_code: 429, parameters: { retry_after: 60 } }, { status: 429 }))).toMatchObject({ kind: "rejected", retryAfterSeconds: 60 });
    expect(await send(new Response("broken", { status: 503 }))).toEqual({ kind: "unknown" });
    expect(await sendAdminAlertMessage({ token: "123:isolated", chatId: "555", text: "down", fetchImpl: async () => { throw Error("secret-url"); } })).toEqual({ kind: "unknown" });
  });
  it("bounds a hung acknowledgement body and cancels the request", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const pending = sendAdminAlertMessage({ token: "123:isolated", chatId: "555", text: "down", fetchImpl: async (_url, init) => {
        signal = init?.signal as AbortSignal;
        return { status: 200, json: () => new Promise(() => {}) } as Response;
      } });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(await pending).toEqual({ kind: "unknown" });
      expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("formats HTML-safe messages with a deep link into the panel", () => {
    const text = formatAdminAlertMessage({ id: "overdue_publications", kind: "fired", severity: "warning", detail: "7 <публикаций>", sinceMs: 0 }, "https://aurora.example/", 0);
    expect(text).toContain("🟠 <b>Аврора · Публикации застряли в очереди</b>");
    expect(text).toContain("7 &lt;публикаций&gt;");
    expect(text).toContain('href="https://aurora.example/admin?pstatus=overdue#publications"');
    expect(formatAdminAlertMessage({ id: "redis", kind: "recovered", severity: "critical", detail: "ok", sinceMs: 0 }, null, 0)).toMatch(/^✅ .*Восстановлено/u);
  });

  it("returns nobody when the allowlist is empty and reads bounded config", async () => {
    const pool = { query: vi.fn() };
    expect(await adminAlertRecipients(pool as never, {})).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
    expect(adminAlertsConfig({ AURORA_ADMIN_ALERTS_INTERVAL_MS: "1000", AURORA_ADMIN_ALERTS_OVERDUE_THRESHOLD: "0" })).toMatchObject({ enabled: true, intervalMs: 300_000, overdueThreshold: 5 });
    expect(adminAlertsConfig({ AURORA_ADMIN_ALERTS: "off" }).enabled).toBe(false);
  });
});
