import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";
import { AdminAlertTracker, deliverAdminAlerts, type AdminAlertCondition } from "@/lib/admin-alerts";
import { runAdminAlertsTick } from "@/lib/admin-alerts-scheduler";

const connectionString = String(process.env.ADMIN_ALERT_TEST_DATABASE_URL || "");
const url = new URL(connectionString);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/aurora_admin_alert_test") throw new Error("Requires disposable aurora_admin_alert_test");
const pool = new pg.Pool({ connectionString, ssl: false, max: 6 });
const repeatMs = 360_000; const intervalMs = 30_000;
let one: number; let two: number; let now: number; let env: Record<string, string>;
const condition = (firing = true): AdminAlertCondition[] => [{ id: "redis", firing, severity: "critical", detail: firing ? "down" : "ok" }];
const tracker = () => new AdminAlertTracker({ pool, repeatMs });
const accepted = () => Response.json({ ok: true, result: { message_id: 91 } });
const rejected = () => Response.json({ ok: false, error_code: 503 }, { status: 503 });
const logger = { error: vi.fn(), info: vi.fn() };
beforeAll(async () => {
  await pool.query("drop schema public cascade"); await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { DATABASE_URL: connectionString }, logger: { log() {} } });
  [one, two] = (await pool.query("insert into users(email,verified_email,tg_chat_id) values('admin-one@fixture.test','admin-one@fixture.test',555),('admin-two@fixture.test','admin-two@fixture.test',556) returning id")).rows.map((row) => Number(row.id));
});
beforeEach(async () => {
  await pool.query("truncate admin_alert_deliveries,admin_alert_notifications,admin_alert_conditions restart identity");
  await pool.query("update users set blocked_at=null,verified_email=email");
  now = Date.now(); logger.error.mockClear(); logger.info.mockClear();
  env = { TG_BOT_TOKEN: "123:isolated-secret", AURORA_ADMIN_USER_IDS: String(one), AURORA_ADMIN_ALERTS_INTERVAL_MS: String(intervalMs) };
});
afterAll(async () => { await pool.end(); });
describe("durable admin alert transition and per-recipient delivery", () => {
  it("retries definite failed real scheduler ticks before the repeat cooldown", async () => {
    const state = tracker();
    const probe = async () => ({ redis: "down" as const, publicationWorker: "up" as const, telegramPolling: "not_configured" as const });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(rejected()).mockResolvedValueOnce(accepted());
    expect(await runAdminAlertsTick({ pool, tracker: state, env, probe, fetchImpl, nowMs: now })).toMatchObject({ sent: 0, failed: 1 });
    expect(await runAdminAlertsTick({ pool, tracker: state, env, probe, fetchImpl, nowMs: now + intervalMs })).toMatchObject({ sent: 1, failed: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await state.transition(condition(), now + intervalMs + 1)).toEqual([]);
  });
  it("does not resend already confirmed recipients when another recipient was rejected", async () => {
    env.AURORA_ADMIN_USER_IDS = `${one},${two}`;
    const state = tracker(); const events = await state.transition(condition(), now);
    const calls: string[] = []; let failed = false;
    const fetchImpl: typeof fetch = async (_url, init) => { const chat = JSON.parse(String(init?.body)).chat_id; calls.push(chat); if (chat === "556" && !failed) { failed = true; return rejected(); } return accepted(); };
    expect(await deliverAdminAlerts({ pool, notifications: events, env, fetchImpl, nowMs: now, logger })).toMatchObject({ sent: 1, failed: 1 });
    expect(await deliverAdminAlerts({ pool, notifications: await state.transition(condition(), now + intervalMs), env, fetchImpl, nowMs: now + intervalMs, logger })).toMatchObject({ sent: 1, failed: 0 });
    expect(calls.filter((chat) => chat === "555")).toHaveLength(1); expect(calls.filter((chat) => chat === "556")).toHaveLength(2);
  });
  it("retains unknown delivery across a new pool/tracker and does not retry malformed acknowledgements", async () => {
    const events = await tracker().transition(condition(), now);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
    expect(await deliverAdminAlerts({ pool, notifications: events, env, fetchImpl, nowMs: now, logger })).toMatchObject({ sent: 0, unknown: 1 });
    const restarted = new pg.Pool({ connectionString, ssl: false });
    try {
      const pending = await new AdminAlertTracker({ pool: restarted, repeatMs }).transition(condition(), now + repeatMs + 1);
      expect(pending[0].eventId).toBe(events[0].eventId);
      expect(await deliverAdminAlerts({ pool: restarted, notifications: pending, env, fetchImpl, nowMs: now + repeatMs + 1, logger })).toMatchObject({ sent: 0, unknown: 1 });
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally { await restarted.end(); }
  });
  it("fences simultaneous web transition and delivery attempts", async () => {
    const [a, b] = await Promise.all([tracker().transition(condition(), now), tracker().transition(condition(), now)]);
    expect(a[0].eventId).toBe(b[0].eventId);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => accepted());
    const results = await Promise.all([a, b].map((notifications) => deliverAdminAlerts({ pool, notifications, env, fetchImpl, nowMs: now, logger })));
    expect(results.reduce((sum, result) => sum + result.sent, 0)).toBe(1); expect(fetchImpl).toHaveBeenCalledOnce();
    expect(Number((await pool.query("select count(*) from admin_alert_notifications")).rows[0].count)).toBe(1);
  });
  it("starts reminders only after confirmed receipt and records one recovery", async () => {
    const state = tracker(); expect(await state.transition(condition(false), now)).toEqual([]);
    const fired = await state.transition(condition(), now + 1);
    await deliverAdminAlerts({ pool, notifications: fired, env, fetchImpl: async () => accepted(), nowMs: now + 10, logger });
    expect(await state.transition(condition(), now + repeatMs + 9)).toEqual([]);
    const reminder = await state.transition(condition(), now + repeatMs + 10); expect(reminder[0].kind).toBe("still_firing");
    const recovery = await state.transition(condition(false), now + repeatMs + 11); expect(recovery[0].kind).toBe("recovered");
    await deliverAdminAlerts({ pool, notifications: recovery, env, fetchImpl: async () => accepted(), nowMs: now + repeatMs + 12, logger });
    expect(await state.transition(condition(false), now + repeatMs + 13)).toEqual([]);
    expect((await pool.query("select superseded_at from admin_alert_notifications where id=$1", [reminder[0].eventId])).rows[0].superseded_at).not.toBeNull();
  });
  it("keeps sending fenced when receipt persistence fails after the provider accepted", async () => {
    const events = await tracker().transition(condition(), now); let loseReceipt = true;
    const faultPool = { query: (sql: string, params?: unknown[]) => {
      if (loseReceipt && sql.includes("set send_status=$4")) { loseReceipt = false; return Promise.reject(Error("synthetic receipt loss")); }
      return pool.query(sql, params);
    } };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => accepted());
    expect(await deliverAdminAlerts({ pool: faultPool as never, notifications: events, env, fetchImpl, nowMs: now, logger })).toMatchObject({ unknown: 1, sent: 0 });
    expect(await deliverAdminAlerts({ pool, notifications: events, env, fetchImpl, nowMs: now + 8001, logger })).toMatchObject({ unknown: 1, sent: 0 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect((await pool.query("select send_status from admin_alert_deliveries")).rows[0].send_status).toBe("unknown");
  });
  it("holds all external sends during restore and preserves pending work", async () => {
    const state = tracker(); const events = await state.transition(condition(), now); const fetchImpl = vi.fn<typeof fetch>();
    expect(await deliverAdminAlerts({ pool, notifications: events, env: { ...env, AURORA_OUTBOUND_DISABLED: "1" }, fetchImpl, nowMs: now, logger })).toMatchObject({ pending: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await state.transition(condition(), now + intervalMs))[0].eventId).toBe(events[0].eventId);
  });
  it("does not recreate restored superseded events with no recipient receipts", async () => {
    const events = await tracker().transition(condition(), now);
    await pool.query("update admin_alert_notifications set superseded_at=now() where id=$1", [events[0].eventId]);
    expect(await tracker().transition(condition(), now + repeatMs + 1)).toEqual([]);
    const fetchImpl = vi.fn<typeof fetch>();
    await deliverAdminAlerts({ pool, notifications: events, env, fetchImpl, nowMs: now + repeatMs + 1, logger });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(Number((await pool.query("select count(*) from admin_alert_deliveries")).rows[0].count)).toBe(0);
    expect(Number((await pool.query("select count(*) from admin_alert_notifications")).rows[0].count)).toBe(1);
    const recovery = await tracker().transition(condition(false), now + repeatMs + 2);
    expect(recovery[0]).toMatchObject({ kind: "recovered" });
    expect(recovery[0].eventId).not.toBe(events[0].eventId);
  });
  it("rechecks a revoked recipient before claiming an external send", async () => {
    const events = await tracker().transition(condition(), now);
    const revokePool = { query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("insert into admin_alert_deliveries")) await pool.query("update users set blocked_at=now() where id=$1", [one]);
      return pool.query(sql, params);
    } };
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await deliverAdminAlerts({ pool: revokePool as never, notifications: events, env, fetchImpl, nowMs: now, logger })).toMatchObject({ sent: 0, pending: 1 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("isolated-secret");
  });
});
