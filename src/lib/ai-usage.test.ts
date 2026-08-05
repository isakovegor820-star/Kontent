import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeAiUsageResult,
  acquireAiUsageRequest,
  aiRequestFingerprint,
  commitAiUsage,
  commitAiUsageResult,
  channelAiContextFor,
  expireAiUsageReservations,
  finalizeAiUsage,
  releaseAiUsage,
  releaseAiUsageRequest,
  reserveAiUsage,
  stageAiUsageResult,
  styleSamplesFor,
  type AiUsageStatus,
} from "./ai-usage";

function fakeReservePool(used: number) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      const normalized = sql.trim().replace(/\s+/gu, " ");
      queries.push(normalized);
      if (sql.includes("select id from users")) return { rowCount: 1, rows: [{ id: 7 }] };
      if (sql.includes("count(*)")) return { rowCount: 1, rows: [{ n: used }] };
      if (sql.includes("insert into ai_usage")) {
        return { rowCount: 1, rows: [{ id: "91", expires_at: new Date("2026-08-01T12:10:00.000Z") }] };
      }
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) }, client, queries };
}

describe("AI usage reservation lifecycle", () => {
  const terminalResult = {
    protocol: "ndjson" as const,
    text: "Готовый результат",
    pipeline: "single" as const,
    requestedEngine: "local",
    engine: "local",
    fallbackUsed: false,
  };
  const operationId = "33333333-3333-4333-8333-333333333333";

  it("locks the account, expires bounded orphans, and creates an auditable reservation", async () => {
    const h = fakeReservePool(29);
    await expect(reserveAiUsage(7, "write", {
      limit: 30,
      reservationKey: "request-123",
      ttlMs: 60_000,
      cleanupBatch: 25,
    }, h.pool as never)).resolves.toEqual({
      allowed: true,
      used: 30,
      limit: 30,
      reservationId: 91,
      reservationKey: "request-123",
      status: "reserved",
      expiresAt: "2026-08-01T12:10:00.000Z",
    });
    expect(h.queries[0]).toBe("begin");
    expect(h.queries[1]).toContain("select id from users where id = $1 for update");
    expect(h.queries[2]).toContain("limit $2 for update skip locked");
    expect(h.queries[3]).toContain("status = 'committed'");
    expect(h.queries[3]).toContain("expires_at > now()");
    expect(h.queries[4]).toContain("'reserved', $3, now()");
    expect(h.queries.at(-1)).toBe("commit");
    expect(h.client.release).toHaveBeenCalledOnce();
  });

  it("does not create a reservation over the active daily limit", async () => {
    const h = fakeReservePool(30);
    await expect(reserveAiUsage(7, "write", { limit: 30 }, h.pool as never)).resolves.toMatchObject({
      allowed: false,
      used: 30,
      limit: 30,
      reservationId: null,
      status: null,
    });
    expect(h.queries.some((sql) => sql.startsWith("insert into ai_usage"))).toBe(false);
    expect(h.queries.at(-1)).toBe("rollback");
  });

  it("serializes concurrent reservations so only one takes the last slot", async () => {
    let active = 0;
    let lockTail = Promise.resolve();
    const pool = {
      connect: vi.fn(async () => {
        let unlock: (() => void) | null = null;
        return {
          async query(sql: string) {
            if (sql.includes("select id from users")) {
              const previous = lockTail;
              lockTail = new Promise<void>((resolve) => { unlock = resolve; });
              await previous;
              return { rowCount: 1, rows: [{ id: 7 }] };
            }
            if (sql.includes("count(*)")) return { rowCount: 1, rows: [{ n: active }] };
            if (sql.includes("insert into ai_usage")) {
              active += 1;
              return {
                rowCount: 1,
                rows: [{ id: String(100 + active), expires_at: "2026-08-01T12:10:00.000Z" }],
              };
            }
            if (sql === "commit" || sql === "rollback") unlock?.();
            return { rowCount: 1, rows: [] };
          },
          release() {},
        };
      }),
    };

    const [first, second] = await Promise.all([
      reserveAiUsage(7, "write", { limit: 1, reservationKey: "request-a" }, pool as never),
      reserveAiUsage(7, "write", { limit: 1, reservationKey: "request-b" }, pool as never),
    ]);
    expect([first, second].filter((item) => item.allowed)).toHaveLength(1);
    expect([first, second].filter((item) => !item.allowed)).toHaveLength(1);
    expect(active).toBe(1);
  });

  it("makes competing commit/release transitions exactly-once and idempotent", async () => {
    let status: AiUsageStatus = "reserved";
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes("update ai_usage")) {
          if (status !== "reserved") return { rowCount: 0, rows: [] };
          status = params[2] as AiUsageStatus;
          return { rowCount: 1, rows: [{ status }] };
        }
        return { rowCount: 1, rows: [{ status }] };
      }),
    };

    const outcomes = await Promise.all([
      commitAiUsage(7, 91, pool as never),
      releaseAiUsage(7, 91, pool as never),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(["committed", "released"]).toContain(status);
    await expect(finalizeAiUsage(7, 91, "released", pool as never)).resolves.toEqual({
      changed: false,
      status,
    });
  });

  it("cannot finalize an expired reservation and never performs a broad mutation", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        void sql;
        return { rowCount: 1, rows: [{ status: "expired" }] };
      }),
    };
    await expect(commitAiUsage(7, 91, pool as never)).resolves.toBe(false);
    await expect(releaseAiUsage(7, null, pool as never)).resolves.toBe(false);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toContain("where id = $1 and user_id = $2 and status = 'reserved'");
    expect(pool.query.mock.calls[0][0]).toContain("expires_at <= now()");
  });

  it("expires orphaned reservations in a bounded, skip-locked batch", async () => {
    const pool = { query: vi.fn(async (sql: string, params?: unknown[]) => {
      void sql;
      void params;
      return { rowCount: 17, rows: [] };
    }) };
    await expect(expireAiUsageReservations(17, pool as never)).resolves.toBe(17);
    expect(pool.query.mock.calls[0][0]).toContain("limit $1");
    expect(pool.query.mock.calls[0][0]).toContain("for update skip locked");
    expect(pool.query.mock.calls[0][0]).toContain("status = 'expired'");
    expect(pool.query.mock.calls[0][1]).toEqual([17]);
  });

  it("replays a committed paid request without counting or reserving again", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("select id from users")) return { rowCount: 1, rows: [{ id: 7 }] };
        if (sql.includes("where user_id = $1 and reservation_key = $2") && sql.includes("for update")) {
          return {
            rowCount: 1,
            rows: [{
              id: "91",
              status: "committed",
              request_fingerprint: aiRequestFingerprint({ input: "same" }),
              result_payload: terminalResult,
              fresh: false,
            }],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };

    await expect(acquireAiUsageRequest(7, "write", {
      reservationKey: "web:request-replay",
      fingerprint: aiRequestFingerprint({ input: "same" }),
      operationId: "11111111-1111-4111-8111-111111111111",
    }, pool as never)).resolves.toMatchObject({
      allowed: false,
      requestState: "replay",
      reservationId: 91,
      result: terminalResult,
    });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("count(*)"))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("insert into ai_usage"))).toBe(false);
  });

  it("replays a staged terminal result without invoking or charging again before ACK", async () => {
    const fingerprint = aiRequestFingerprint({ input: "pending ack" });
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("select id from users")) return { rowCount: 1, rows: [{ id: 7 }] };
        if (sql.includes("where user_id = $1 and reservation_key = $2") && sql.includes("for update")) {
          return {
            rowCount: 1,
            rows: [{
              id: "91",
              status: "reserved",
              request_fingerprint: fingerprint,
              result_payload: terminalResult,
              fresh: true,
            }],
          };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };

    await expect(acquireAiUsageRequest(7, "write", {
      reservationKey: "web:request-pending-ack",
      fingerprint,
      operationId: "11111111-1111-4111-8111-111111111112",
    }, pool as never)).resolves.toMatchObject({
      allowed: false,
      requestState: "terminal_pending_ack",
      reservationId: 91,
      result: terminalResult,
    });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("count(*)"))).toBe(false);
  });

  it("reuses a released request key and excludes its audit row from the daily count", async () => {
    const queries: Array<[string, unknown[] | undefined]> = [];
    const fingerprint = aiRequestFingerprint({ input: "retry" });
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push([sql, params]);
        if (sql.includes("select id from users")) return { rowCount: 1, rows: [{ id: 7 }] };
        if (sql.includes("where user_id = $1 and reservation_key = $2") && sql.includes("for update")) {
          return {
            rowCount: 1,
            rows: [{ id: "91", status: "released", request_fingerprint: fingerprint, result_payload: null, fresh: false }],
          };
        }
        if (sql.includes("count(*)")) return { rowCount: 1, rows: [{ n: 4 }] };
        if (sql.includes("set kind = $3, status = 'reserved'")) {
          return { rowCount: 1, rows: [{ id: "91", expires_at: "2026-08-05T12:10:00.000Z" }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) };

    await expect(acquireAiUsageRequest(7, "write", {
      reservationKey: "web:request-released",
      fingerprint,
      operationId: "22222222-2222-4222-8222-222222222222",
    }, pool as never)).resolves.toMatchObject({
      allowed: true,
      requestState: "acquired",
      reservationId: 91,
      used: 5,
    });
    const countQuery = queries.find(([sql]) => sql.includes("count(*)"));
    expect(countQuery?.[0]).toContain("id <> coalesce($2::bigint, 0)");
    expect(countQuery?.[1]).toEqual([7, "91"]);
  });

  it("stores the terminal result in the same transition that commits quota", async () => {
    let status: AiUsageStatus = "reserved";
    let stored: unknown = null;
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes("result_payload = case")) {
          status = "committed";
          stored = JSON.parse(String(params[3]));
          return { rowCount: 1, rows: [{ status, result_payload: stored }] };
        }
        if (sql.includes("update ai_usage")) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ status, result_payload: stored }] };
      }),
    };

    await expect(commitAiUsageResult(7, 91, operationId, terminalResult, pool as never)).resolves.toMatchObject({
      changed: true,
      status: "committed",
      result: terminalResult,
    });
    await expect(releaseAiUsage(7, 91, pool as never)).resolves.toBe(false);
    expect(status).toBe("committed");
  });

  it("stages one terminal result without charging and commits only after an idempotent ACK", async () => {
    let status: AiUsageStatus = "reserved";
    let stored: unknown = null;
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        if (sql.includes("operation_id = $3::uuid") && sql.includes("else 'reserved'")) {
          stored = JSON.parse(String(params[3]));
          return { rowCount: 1, rows: [{ status: "reserved", result_payload: stored }] };
        }
        if (sql.includes("reservation_key = $2") && sql.includes("update ai_usage")) {
          if (status !== "reserved") return { rowCount: 0, rows: [] };
          status = "committed";
          return { rowCount: 1, rows: [{ status, result_payload: stored }] };
        }
        if (sql.includes("reservation_key = $2") && sql.includes("select status")) {
          return { rowCount: 1, rows: [{ status, result_payload: stored }] };
        }
        return { rowCount: 0, rows: [] };
      }),
    };

    await expect(stageAiUsageResult(7, 91, operationId, terminalResult, pool as never)).resolves.toEqual({
      changed: true,
      status: "reserved",
      result: terminalResult,
    });
    expect(status).toBe("reserved");

    await expect(acknowledgeAiUsageResult(7, "web:request-two-phase", pool as never)).resolves.toEqual({
      changed: true,
      status: "committed",
      result: terminalResult,
    });
    await expect(acknowledgeAiUsageResult(7, "web:request-two-phase", pool as never)).resolves.toEqual({
      changed: false,
      status: "committed",
      result: terminalResult,
    });
  });

  it("does not let a stale attempt commit or release a retried reservation row", async () => {
    const currentOperationId = "44444444-4444-4444-8444-444444444444";
    let status: AiUsageStatus = "reserved";
    const pool = {
      query: vi.fn(async (sql: string, params: unknown[]) => {
        const operationMatches = params[2] === currentOperationId;
        if (sql.includes("update ai_usage")) {
          if (!operationMatches || status !== "reserved") return { rowCount: 0, rows: [] };
          status = sql.includes("result_payload = case") ? "committed" : "released";
          return {
            rowCount: 1,
            rows: [{ status, result_payload: status === "committed" ? terminalResult : null }],
          };
        }
        return operationMatches
          ? { rowCount: 1, rows: [{ status, result_payload: null }] }
          : { rowCount: 0, rows: [] };
      }),
    };

    await expect(commitAiUsageResult(
      7,
      91,
      operationId,
      terminalResult,
      pool as never,
    )).resolves.toEqual({ changed: false, status: null, result: null });
    await expect(releaseAiUsageRequest(7, 91, operationId, pool as never)).resolves.toBe(false);
    expect(status).toBe("reserved");
    expect(pool.query.mock.calls[0][0]).toContain("operation_id = $3::uuid");
    expect(pool.query.mock.calls[2][0]).toContain("operation_id = $3::uuid");
  });
});

describe("styleSamplesFor", () => {
  it("uses only externally verified, channel-scoped, non-RSS posts", async () => {
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        void sql;
        void params;
        return { rows: [{ text: "verified sample" }] };
      }),
    };

    await expect(styleSamplesFor(7, 18, 10, pool as never)).resolves.toEqual([
      "verified sample",
    ]);
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("channel_id = $2");
    expect(sql).toContain("verification_state = 'verified'");
    expect(sql).toContain("not exists (select 1 from rss_items");
    expect(params).toEqual([7, 18, 10]);
  });

  it("fails closed instead of mixing style across channels", async () => {
    const pool = { query: vi.fn() };
    await expect(styleSamplesFor(7, null, 10, pool as never)).resolves.toEqual([]);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("channelAiContextFor", () => {
  it("selects the profile field-by-field and ignores a junk legacy edit", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("from channels")) {
          return { rows: [{ id: "18", title: "Право и технологии", handle: "legaltech", network: "tg" }] };
        }
        if (sql.includes("kind in ('profile_edit', 'profile')")) {
          return {
            rows: [
              {
                id: "8",
                kind: "profile_edit",
                raw_text: "Ниша канала: аоао\n\nАудитория канала: ава аавоа\n\nТон общения автора: Спокойный экспертный тон без канцелярита",
                status: "ready",
                added_at: "2026-08-01T10:00:00.000Z",
              },
              {
                id: "7",
                kind: "profile",
                raw_text: "Ниша канала: Legal tech\n\nУслуги и продукты: Анализ договоров для юридических команд",
                status: "ready",
                added_at: "2026-07-31T10:00:00.000Z",
              },
            ],
          };
        }
        if (sql.includes("from content_brief")) {
          return {
            rows: [{
              niche: "Технологии и право",
              audience: "Юристы и руководители юридических команд",
              rubrics: ["Разбор кейса"],
              formats: ["Видео", "Текст"],
              author_role: "Основатель legal-tech продукта",
              goal: "Новая культура юридического бизнеса",
              cta: "Записаться на разбор договора",
              taboo: "Непроверенные обещания",
              profile_answers: {
                q1: "Канал объясняет, как технологии меняют юридическую практику.",
              },
              quality: {
                tone: "Спокойно и предметно",
                minChars: 1200,
                styleExamples: ["Ручной пример голоса автора для выбранного канала."],
              },
              ready: true,
              updated_at: "2026-07-30T10:00:00.000Z",
            }],
          };
        }
        if (sql.includes("kind in ('form', 'paste')")) return { rows: [] };
        if (sql.includes("select text from posts")) return { rows: [{ text: "Проверенный голос канала" }] };
        if (sql.includes("select count(*)::text as count from posts")) return { rows: [{ count: "7" }] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    };

    const context = await channelAiContextFor(7, 18, 10, pool as never);
    expect(context?.profile).toContain("Ниша канала: Технологии и право");
    expect(context?.profile).toContain("Услуги и продукты: Анализ договоров для юридических команд");
    expect(context?.profile).toContain("Форматы публикаций: Видео, Текст");
    expect(context?.profile).toContain("Роль автора: Основатель legal-tech продукта");
    expect(context?.profile).toContain("Следующий шаг читателя: Записаться на разбор договора");
    expect(context?.profile).toContain("Канал объясняет, как технологии меняют юридическую практику.");
    expect(context?.profile).not.toContain("аоао");
    expect(context?.profileProvenance.niche).toMatchObject({
      sourceId: "content-brief",
      verified: true,
    });
    expect(context?.profileProvenance.tone).toMatchObject({
      sourceId: "knowledge-8",
      sourceKind: "profile_edit",
      verified: true,
    });
    expect(context?.quality.minChars).toBe(1200);
    expect(context?.postIndex).toBe(7);
    expect(context?.styleSamples).toEqual([
      "Ручной пример голоса автора для выбранного канала.",
      "Проверенный голос канала",
    ]);
  });
});
