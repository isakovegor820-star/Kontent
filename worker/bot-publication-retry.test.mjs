import { describe, expect, it, vi } from "vitest";
import {
  botRetryJobId,
  retryFailedPostFromBot,
  telegramRetryKey,
} from "./bot-publication-retry.mjs";

const compact = (sql) => sql.replace(/\s+/g, " ").trim();

describe("Telegram publication retry", () => {
  it("uses one deterministic job for a redelivered callback", async () => {
    const post = { id: 41, userId: 7, status: "failed", lastRetryKey: null };
    const pool = {
      query: vi.fn(async (sqlValue, params) => {
        const sql = compact(sqlValue);
        if (sql.startsWith("update posts") && sql.includes("status = 'failed'")) {
          if (post.id === params[0] && post.userId === params[1] && post.status === "failed") {
            post.status = "scheduled";
            post.lastRetryKey = params[2];
            return { rows: [{ id: post.id }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("select status, last_retry_key")) {
          return {
            rows: post.id === params[0] && post.userId === params[1]
              ? [{ status: post.status, last_retry_key: post.lastRetryKey }]
              : [],
            rowCount: 1,
          };
        }
        throw new Error(`Unexpected query: ${sql}`);
      }),
    };
    const queue = { add: vi.fn().mockResolvedValue({ id: "job" }) };
    const input = { pool, queue, userId: 7, postId: 41, callbackQueryId: "callback:opaque:1" };

    await expect(retryFailedPostFromBot(input)).resolves.toMatchObject({ kind: "queued" });
    await expect(retryFailedPostFromBot(input)).resolves.toEqual({ kind: "replayed" });

    const retryKey = telegramRetryKey(input.callbackQueryId);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      "publish",
      { postId: 41 },
      expect.objectContaining({ jobId: botRetryJobId(41, retryKey) }),
    );
    expect(botRetryJobId(41, retryKey)).toBe(botRetryJobId(41, retryKey));
    expect(botRetryJobId(41, retryKey)).not.toBe(
      botRetryJobId(41, telegramRetryKey("a different callback")),
    );
  });

  it.each([
    ["publishing", 7],
    ["published_unverified", 7],
    ["failed", 99],
  ])("does not retry status %s for user %s", async (status, userId) => {
    const calls = [];
    const pool = {
      query: vi.fn(async (sqlValue, params) => {
        const sql = compact(sqlValue);
        calls.push({ sql, params });
        if (sql.startsWith("update posts")) return { rows: [], rowCount: 0 };
        return {
          rows: userId === 7 ? [{ status, last_retry_key: null }] : [],
          rowCount: userId === 7 ? 1 : 0,
        };
      }),
    };
    const queue = { add: vi.fn() };

    await expect(
      retryFailedPostFromBot({
        pool,
        queue,
        userId,
        postId: 41,
        callbackQueryId: "callback:opaque:2",
      }),
    ).resolves.toEqual({ kind: "not_retryable" });

    expect(queue.add).not.toHaveBeenCalled();
    expect(calls[0].sql).toContain("user_id = $2 and status = 'failed'");
    expect(calls[0].params.slice(0, 2)).toEqual([41, userId]);
    expect(calls[1].sql).toContain("where id = $1 and user_id = $2");
    expect(calls[1].params).toEqual([41, userId]);
  });

  it("restores the owned claimed post to failed when queue insertion fails", async () => {
    const calls = [];
    const pool = {
      query: vi.fn(async (sqlValue, params) => {
        const sql = compact(sqlValue);
        calls.push({ sql, params });
        return { rows: sql.includes("returning id") ? [{ id: 41 }] : [], rowCount: 1 };
      }),
    };
    const queueError = new Error("redis unavailable");
    const queue = { add: vi.fn().mockRejectedValue(queueError) };

    const result = await retryFailedPostFromBot({
      pool,
      queue,
      userId: 7,
      postId: 41,
      callbackQueryId: "callback:opaque:3",
    });

    expect(result).toMatchObject({ kind: "queue_unavailable", compensated: true, queueError });
    expect(calls).toHaveLength(2);
    expect(calls[1].sql).toContain("where id = $1 and user_id = $2");
    expect(calls[1].sql).toContain("status = 'scheduled' and last_retry_key = $3");
    expect(calls[1].params.slice(0, 3)).toEqual([
      41,
      7,
      telegramRetryKey("callback:opaque:3"),
    ]);
  });
});
