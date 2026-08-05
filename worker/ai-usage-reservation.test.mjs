import { describe, expect, it } from "vitest";
import {
  acquireWorkerAiUsage,
  commitWorkerAiUsage,
  heartbeatWorkerAiUsage,
  releaseWorkerAiUsage,
  workerAiUsageCompositeKey,
  workerAiUsageKey,
} from "./ai-usage-reservation.mjs";

function memoryPool(initial = []) {
  const rows = initial.map((row) => ({ ...row }));
  let nextId = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1;
  let lockTail = Promise.resolve();

  const execute = async (sql, params = [], clientState = null) => {
    const normalized = sql.trim().replace(/\s+/gu, " ");
    if (normalized === "begin") return { rowCount: 0, rows: [] };
    if (normalized === "commit" || normalized === "rollback") {
      clientState?.unlock?.();
      if (clientState) clientState.unlock = null;
      return { rowCount: 0, rows: [] };
    }
    if (normalized.includes("select id from users")) {
      const previous = lockTail;
      lockTail = new Promise((resolve) => { clientState.unlock = resolve; });
      await previous;
      return { rowCount: 1, rows: [{ id: params[0] }] };
    }
    if (normalized.startsWith("with stale as")) {
      const now = Date.now();
      let changed = 0;
      for (const row of rows) {
        if (row.userId === params[0] && row.status === "reserved" && row.expiresAt <= now && changed < params[1]) {
          row.status = "expired";
          changed += 1;
        }
      }
      return { rowCount: changed, rows: [] };
    }
    if (normalized.includes("where user_id = $1 and reservation_key = $2")) {
      const row = rows.find((item) => item.userId === params[0] && item.key === params[1]);
      if (!row) return { rowCount: 0, rows: [] };
      const fresh = row.status === "reserved"
        && row.expiresAt > Date.now()
        && row.reservedAt > Date.now() - params[2];
      return { rowCount: 1, rows: [{ id: row.id, status: row.status, fresh }] };
    }
    if (normalized.startsWith("select count(*)::int as n")) {
      const count = rows.filter((row) => row.userId === params[0]
        && row.id !== Number(params[1] || 0)
        && (row.status === "committed" || (row.status === "reserved" && row.expiresAt > Date.now()))).length;
      return { rowCount: 1, rows: [{ n: count }] };
    }
    if (normalized.startsWith("insert into ai_usage")) {
      const row = {
        id: nextId++,
        userId: params[0],
        kind: params[1],
        key: params[2],
        status: "reserved",
        reservedAt: Date.now(),
        expiresAt: Date.now() + params[3],
      };
      rows.push(row);
      return { rowCount: 1, rows: [{ id: row.id, expires_at: new Date(row.expiresAt) }] };
    }
    if (normalized.startsWith("update ai_usage") && normalized.includes("set kind = $3")) {
      const row = rows.find((item) => item.id === Number(params[0]) && item.userId === params[1]);
      if (!row || !["reserved", "released", "expired"].includes(row.status)) return { rowCount: 0, rows: [] };
      row.kind = params[2];
      row.status = "reserved";
      row.reservedAt = Date.now();
      row.expiresAt = Date.now() + params[3];
      return { rowCount: 1, rows: [{ id: row.id, expires_at: new Date(row.expiresAt) }] };
    }
    if (normalized.startsWith("update ai_usage") && normalized.includes("set status = case")) {
      const row = rows.find((item) => item.id === Number(params[0]) && item.userId === params[1]);
      if (!row || row.status !== "reserved") return { rowCount: 0, rows: [] };
      row.status = row.expiresAt <= Date.now() ? "expired" : params[2];
      return { rowCount: 1, rows: [{ status: row.status }] };
    }
    if (normalized.startsWith("select status from ai_usage")) {
      const row = rows.find((item) => item.id === Number(params[0]) && item.userId === params[1]);
      return row ? { rowCount: 1, rows: [{ status: row.status }] } : { rowCount: 0, rows: [] };
    }
    if (normalized.startsWith("update ai_usage") && normalized.includes("set reserved_at = now()")) {
      const row = rows.find((item) => item.id === Number(params[0]) && item.userId === params[1]);
      if (!row || row.status !== "reserved" || row.expiresAt <= Date.now()) return { rowCount: 0, rows: [] };
      row.reservedAt = Date.now();
      row.expiresAt = Date.now() + params[2];
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected SQL: ${normalized}`);
  };

  return {
    rows,
    async connect() {
      const clientState = { unlock: null };
      return {
        query: (sql, params) => execute(sql, params, clientState),
        release() {
          clientState.unlock?.();
          clientState.unlock = null;
        },
      };
    },
    query: (sql, params) => execute(sql, params),
  };
}

const options = (key) => ({
  userId: 7,
  kind: "bot-idea",
  key,
  limit: 2,
  ttlMs: 60_000,
  reclaimAfterMs: 15_000,
});

describe("worker AI usage reservations", () => {
  it("builds stable, bounded operation keys", () => {
    expect(workerAiUsageKey("autopilot-plan", 91)).toBe("worker:autopilot-plan:91");
    expect(workerAiUsageKey("bot-idea", 112233)).toBe("worker:bot-idea:112233");
    expect(() => workerAiUsageKey("bad scope!", 1)).toThrow(/scope/u);
    expect(workerAiUsageCompositeKey("autopilot-weekly", [44, "2026-07-27"]))
      .toBe("worker:autopilot-weekly:44:2026-07-27");
    expect(() => workerAiUsageCompositeKey("rss-summary", [44, "bad part!"]))
      .toThrow(/key part/u);
  });

  it("serializes duplicate callbacks so only one owns the provider call", async () => {
    const pool = memoryPool();
    const key = workerAiUsageKey("bot-idea", 500);
    const results = await Promise.all([
      acquireWorkerAiUsage(pool, options(key)),
      acquireWorkerAiUsage(pool, options(key)),
    ]);
    expect(results.map((result) => result.state).sort()).toEqual(["acquired", "in_progress"]);
    expect(pool.rows).toHaveLength(1);
  });

  it("reuses a released row on BullMQ retry without creating another operation", async () => {
    const pool = memoryPool();
    const key = workerAiUsageKey("autopilot-plan", 91);
    const first = await acquireWorkerAiUsage(pool, options(key));
    expect(first.state).toBe("acquired");
    await expect(releaseWorkerAiUsage(pool, 7, first.reservationId)).resolves.toBe(true);
    const retry = await acquireWorkerAiUsage(pool, options(key));
    expect(retry).toMatchObject({ state: "acquired", reservationId: first.reservationId });
    expect(pool.rows).toHaveLength(1);
  });

  it("reclaims a stale lease after a crashed worker but not a fresh concurrent owner", async () => {
    const pool = memoryPool();
    const key = workerAiUsageKey("autopilot-plan", 92);
    const first = await acquireWorkerAiUsage(pool, options(key));
    pool.rows[0].reservedAt = Date.now() - 20_000;
    const recovered = await acquireWorkerAiUsage(pool, options(key));
    expect(recovered).toMatchObject({ state: "acquired", reservationId: first.reservationId });
    expect(pool.rows).toHaveLength(1);
  });

  it("recognizes a committed replay and does not reserve or charge again", async () => {
    const pool = memoryPool();
    const key = workerAiUsageKey("bot-idea", 501);
    const first = await acquireWorkerAiUsage(pool, options(key));
    await expect(commitWorkerAiUsage(pool, 7, first.reservationId)).resolves.toBe(true);
    const replay = await acquireWorkerAiUsage(pool, options(key));
    expect(replay).toMatchObject({ state: "committed", reservationId: first.reservationId });
    expect(pool.rows).toHaveLength(1);
  });

  it("returns an explicit quota result without inserting", async () => {
    const pool = memoryPool([{
      id: 1,
      userId: 7,
      kind: "write",
      key: "worker:existing:1",
      status: "committed",
      reservedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }]);
    const result = await acquireWorkerAiUsage(pool, {
      ...options(workerAiUsageKey("bot-idea", 502)),
      limit: 1,
    });
    expect(result).toMatchObject({ state: "limit", used: 1, limit: 1, reservationId: null });
    expect(pool.rows).toHaveLength(1);
  });

  it("finalizes competing commit/release exactly once", async () => {
    const pool = memoryPool();
    const acquired = await acquireWorkerAiUsage(pool, options(workerAiUsageKey("bot-idea", 503)));
    const outcomes = await Promise.all([
      commitWorkerAiUsage(pool, 7, acquired.reservationId),
      releaseWorkerAiUsage(pool, 7, acquired.reservationId),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(["committed", "released"]).toContain(pool.rows[0].status);
  });

  it("heartbeats only a live reservation", async () => {
    const pool = memoryPool();
    const acquired = await acquireWorkerAiUsage(pool, options(workerAiUsageKey("bot-idea", 504)));
    const before = pool.rows[0].expiresAt;
    await expect(heartbeatWorkerAiUsage(pool, 7, acquired.reservationId, 120_000)).resolves.toBe(true);
    expect(pool.rows[0].expiresAt).toBeGreaterThan(before);
    await releaseWorkerAiUsage(pool, 7, acquired.reservationId);
    await expect(heartbeatWorkerAiUsage(pool, 7, acquired.reservationId, 120_000)).resolves.toBe(false);
  });
});
