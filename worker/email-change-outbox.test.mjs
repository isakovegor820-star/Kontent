import { beforeEach, describe, expect, it, vi } from "vitest";

import { encryptToken } from "../src/lib/token-crypto.mjs";
import { processEmailChangeOutbox } from "./email-change-outbox.mjs";

describe("email change outbox", () => {
  const txQuery = vi.fn();
  const poolQuery = vi.fn();
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({ query: txQuery, release })),
    query: poolQuery,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TOKENS_MASTER_KEY = "email-change-worker-test-key";
  });

  it("delivers with the durable request idempotency key and marks the row sent", async () => {
    const envelope = encryptToken("one-time-token", { userId: 7, provider: "email-change" });
    txQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{
        id: "9",
        user_id: "7",
        request_id: "41",
        generation: "3",
        recipient: "new@example.test",
        token_envelope: envelope,
        attempts: 0,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        confirmed_at: null,
        cancelled_at: null,
        email_change_generation: "3",
      }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    poolQuery.mockResolvedValue({ rowCount: 1 });
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init.headers["idempotency-key"]).toBe("email-change-41");
      expect(init.headers.authorization).not.toContain("one-time-token");
      return { ok: true };
    });

    await expect(processEmailChangeOutbox(pool, 9, {
      env: {
        APP_URL: "https://aurora.example",
        RESEND_API_KEY: "provider-key",
        EMAIL_CHANGE_FROM: "Aurora <no-reply@aurora.example>",
      },
      fetchImpl,
    })).resolves.toEqual({ status: "sent" });
    expect(poolQuery.mock.calls[0][0]).toContain("status = 'sent'");
    expect(release).toHaveBeenCalled();
  });

  it("cancels an expired request before decrypting or calling the provider", async () => {
    txQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{
        id: "9",
        user_id: "7",
        request_id: "41",
        generation: "3",
        recipient: "new@example.test",
        token_envelope: "not-a-token",
        attempts: 0,
        expires_at: new Date(Date.now() - 60_000).toISOString(),
        confirmed_at: null,
        cancelled_at: null,
        email_change_generation: "3",
      }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    const fetchImpl = vi.fn();
    await expect(processEmailChangeOutbox(pool, 9, { fetchImpl })).resolves.toEqual({ status: "cancelled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
