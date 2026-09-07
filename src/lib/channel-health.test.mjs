import { describe, expect, it, vi } from "vitest";

import {
  classifyOAuthChannelFailure,
  classifyTelegramChannelFailure,
  classifyVkChannelFailure,
  safeChannelErrorCode,
  transitionChannelHealth,
} from "./channel-health.mjs";

describe("channel health classification", () => {
  it("distinguishes Telegram removal and lost permissions", () => {
    expect(classifyTelegramChannelFailure({ providerErrorCode: 403, reason: "bot was kicked" })).toEqual({
      status: "revoked",
      errorCode: "telegram_bot_removed",
    });
    expect(classifyTelegramChannelFailure({ providerErrorCode: 403, reason: "not enough rights" })).toEqual({
      status: "permission_lost",
      errorCode: "telegram_publish_permission_lost",
    });
    expect(classifyTelegramChannelFailure({ providerErrorCode: 400, reason: "Bad Request: chat not found" })).toEqual({
      status: "needs_reconnect",
      errorCode: "telegram_chat_not_found",
    });
  });

  it("distinguishes VK invalid token and permission denied", () => {
    expect(classifyVkChannelFailure({ outcome: "auth_failed", code: "vk_auth_5" })).toEqual({
      status: "revoked",
      errorCode: "vk_auth_5",
    });
    expect(classifyVkChannelFailure({ outcome: "auth_failed", code: "vk_permission_15" })).toEqual({
      status: "permission_lost",
      errorCode: "vk_permission_15",
    });
  });

  it("marks terminal OAuth refresh failure for reconnect and sanitizes codes", () => {
    expect(classifyOAuthChannelFailure({ outcome: "auth_failed", code: "oauth_refresh_failed" })).toEqual({
      status: "needs_reconnect",
      errorCode: "oauth_refresh_failed",
    });
    expect(safeChannelErrorCode("secret value with spaces")).toBe("provider_auth_failed");
  });

  it("uses explicit PostgreSQL parameter types and records a reversible health transition", async () => {
    const query = vi.fn(async (sql) => {
      if (sql === "begin" || sql === "commit") return { rows: [], rowCount: 0 };
      if (String(sql).includes("for update")) return { rows: [{ id: 21, user_id: 7, status: "active" }], rowCount: 1 };
      if (String(sql).includes("update channels")) {
        expect(sql).toContain("$2::text");
        expect(sql).toContain("$3::text");
        return { rows: [], rowCount: 1 };
      }
      if (String(sql).includes("insert into channel_events")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const db = { connect: vi.fn(async () => ({ query, release })) };
    await expect(transitionChannelHealth(db, {
      channelId: 21,
      status: "needs_reconnect",
      errorCode: "telegram_chat_not_found",
      action: "telegram_health_reconciliation",
    })).resolves.toEqual({
      channelId: 21,
      fromStatus: "active",
      status: "needs_reconnect",
      errorCode: "telegram_chat_not_found",
    });
    expect(release).toHaveBeenCalledOnce();
  });
});


describe("channel health transaction ownership", () => {
  for (const outcome of ["updated", "missing", "failed"]) {
    it(`does not manage the caller transaction when its transition is ${outcome}`, async () => {
      const failure = new Error("fixture event write failed");
      const query = vi.fn(async (sql) => {
        if (String(sql).includes("for update")) return { rows: outcome === "missing" ? [] : [{ id: 21, user_id: 7, status: "permission_lost" }], rowCount: outcome === "missing" ? 0 : 1 };
        if (String(sql).includes("update channels")) return { rows: [], rowCount: 1 };
        if (String(sql).includes("insert into channel_events")) {
          if (outcome === "failed") throw failure;
          return { rows: [], rowCount: 1 };
        }
        throw new Error("unexpected transaction-management SQL");
      });
      const client = { query, release: vi.fn() };
      const pool = { connect: vi.fn(() => { throw new Error("unexpected nested connection"); }) };
      const promise = transitionChannelHealth(pool, { channelId: 21, status: "active", action: "reconnected" }, { client });
      if (outcome === "failed") await expect(promise).rejects.toBe(failure);
      else if (outcome === "missing") await expect(promise).resolves.toBeNull();
      else await expect(promise).resolves.toMatchObject({ channelId: 21, fromStatus: "permission_lost", status: "active" });
      expect(pool.connect).not.toHaveBeenCalled();
      expect(client.release).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => /^(?:begin|commit|rollback)$/iu.test(sql))).toBe(false);
    });
  }
  it("still rolls back and releases an owned transaction when an event fails", async () => {
    const failure = new Error("fixture event write failed");
    const query = vi.fn(async (sql) => {
      if (String(sql).includes("for update")) return { rows: [{ id: 21, status: "permission_lost" }] };
      if (String(sql).includes("insert into channel_events")) throw failure;
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    await expect(transitionChannelHealth({ connect: async () => ({ query, release }) }, { channelId: 21, status: "active" })).rejects.toBe(failure);
    expect(query).toHaveBeenCalledWith("begin");
    expect(query).toHaveBeenCalledWith("rollback");
    expect(query).not.toHaveBeenCalledWith("commit");
    expect(release).toHaveBeenCalledOnce();
  });
});
