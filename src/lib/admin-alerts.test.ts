import { describe, expect, it, vi } from "vitest";

import {
  AdminAlertTracker,
  adminAlertRecipients,
  adminAlertsConfig,
  deliverAdminAlerts,
  evaluateAdminAlertConditions,
  formatAdminAlertMessage,
  type AdminAlertCondition,
} from "./admin-alerts";

const condition = (id: AdminAlertCondition["id"], firing: boolean): AdminAlertCondition => ({
  id, firing, severity: "critical", detail: firing ? "down" : "ok",
});

describe("admin alert tracker", () => {
  it("notifies once on failure, repeats after the cooldown and once on recovery", () => {
    const tracker = new AdminAlertTracker({ repeatMs: 60_000 });
    expect(tracker.transition([condition("redis", false)], 0)).toEqual([]);
    expect(tracker.transition([condition("redis", true)], 1_000).map((item) => item.kind)).toEqual(["fired"]);
    expect(tracker.transition([condition("redis", true)], 30_000)).toEqual([]);
    expect(tracker.transition([condition("redis", true)], 61_000).map((item) => item.kind)).toEqual(["still_firing"]);
    expect(tracker.transition([condition("redis", true)], 90_000)).toEqual([]);
    const recovered = tracker.transition([condition("redis", false)], 100_000);
    expect(recovered).toMatchObject([{ id: "redis", kind: "recovered", sinceMs: 1_000 }]);
    expect(tracker.transition([condition("redis", false)], 200_000)).toEqual([]);
  });

  it("stays silent for components that were never seen failing", () => {
    const tracker = new AdminAlertTracker();
    expect(tracker.transition([condition("database", false), condition("publication_worker", false)])).toEqual([]);
  });
});

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
  it("formats HTML-safe messages with a deep link into the panel", () => {
    const text = formatAdminAlertMessage({ id: "overdue_publications", kind: "fired", severity: "warning", detail: "7 <публикаций>", sinceMs: 0 }, "https://aurora.example/", 0);
    expect(text).toContain("🟠 <b>Аврора · Публикации застряли в очереди</b>");
    expect(text).toContain("7 &lt;публикаций&gt;");
    expect(text).toContain('href="https://aurora.example/admin?pstatus=overdue#publications"');
    expect(formatAdminAlertMessage({ id: "redis", kind: "recovered", severity: "critical", detail: "ok", sinceMs: 0 }, null, 0)).toMatch(/^✅ .*Восстановлено/u);
  });

  it("sends only to allowlisted admins with a linked chat and never leaks the token in logs", async () => {
    const pool = { query: vi.fn(async (_sql: string, params: unknown[]) => {
      expect(params).toEqual([[1, 2], ["ops@example.com"]]);
      return { rowCount: 1, rows: [{ id: 1, tg_chat_id: "555" }] };
    }) };
    const send: (url: string | URL | Request, init?: RequestInit) => Promise<Response> = async () => new Response("{}", { status: 200 });
    const fetchImpl = vi.fn(send);
    const logger = { error: vi.fn(), info: vi.fn() };
    const env = { TG_BOT_TOKEN: "123:secret-token", AURORA_ADMIN_USER_IDS: "1,2", AURORA_ADMIN_EMAILS: "ops@example.com", APP_URL: "https://aurora.example" };
    const result = await deliverAdminAlerts({
      pool: pool as never,
      notifications: [{ id: "redis", kind: "fired", severity: "critical", detail: "PING не отвечает", sinceMs: 0 }],
      env, fetchImpl: fetchImpl as never, logger,
    });
    expect(result).toEqual({ sent: 1, failed: 0, recipients: 1 });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ chat_id: "555", parse_mode: "HTML" });
    expect(logger.error).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValueOnce(new Response("{}", { status: 403 }));
    const failed = await deliverAdminAlerts({ pool: pool as never, notifications: [{ id: "redis", kind: "fired", severity: "critical", detail: "x", sinceMs: 0 }], env, fetchImpl: fetchImpl as never, logger });
    expect(failed.failed).toBe(1);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret-token");
  });

  it("returns nobody when the allowlist is empty and reads bounded config", async () => {
    const pool = { query: vi.fn() };
    expect(await adminAlertRecipients(pool as never, {})).toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
    expect(adminAlertsConfig({ AURORA_ADMIN_ALERTS_INTERVAL_MS: "1000", AURORA_ADMIN_ALERTS_OVERDUE_THRESHOLD: "0" })).toMatchObject({ enabled: true, intervalMs: 300_000, overdueThreshold: 5 });
    expect(adminAlertsConfig({ AURORA_ADMIN_ALERTS: "off" }).enabled).toBe(false);
  });
});
