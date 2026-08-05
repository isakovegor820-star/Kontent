import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  consumeEmailChange,
  createEmailChangeOutboxRequest,
  createEmailChangeToken,
  emailChangeFingerprint,
  emailChangeUrl,
  hashEmailChangeToken,
} from "./email-change";

describe("email change token", () => {
  it("stores only a one-way token hash and keeps the raw token in a URL fragment", () => {
    const created = createEmailChangeToken(new Date("2026-08-05T12:00:00Z"));
    expect(created.token).toHaveLength(43);
    expect(created.tokenHash).toBe(hashEmailChangeToken(created.token));
    const url = new URL(emailChangeUrl("https://aurora.example", created.token));
    expect(url.pathname).toBe("/confirm-email");
    expect(url.search).toBe("");
    expect(url.hash).toContain("token=");
    expect(emailChangeFingerprint(" New@Example.Test ")).toBe(emailChangeFingerprint("new@example.test"));
  });
});

describe("createEmailChangeOutboxRequest", () => {
  it("replays the durable request without generating another token or outbox row", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{
        id: "41",
        request_fingerprint: emailChangeFingerprint("new@example.test"),
        target_email: "new@example.test",
        expires_at: "2026-08-05T14:00:00Z",
      }] })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };

    await expect(createEmailChangeOutboxRequest({
      userId: 7,
      targetEmail: "new@example.test",
      requestKey: "email-change:one",
    }, pool as never)).resolves.toMatchObject({ status: "replayed", requestId: 41 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into email_change_requests"))).toBe(false);
    expect(release).toHaveBeenCalled();
  });
});

describe("consumeEmailChange", () => {
  const query = vi.fn();
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("changes email only for a live current generation and confirms the token once", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{
        id: "8",
        user_id: "3",
        target_email: "new@example.test",
        generation: "2",
        expires_at: "2026-08-05T13:30:00Z",
        confirmed_at: null,
        cancelled_at: null,
        email_change_generation: "2",
      }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await expect(consumeEmailChange(
      { token: "x".repeat(32), now: new Date("2026-08-05T13:00:00Z") },
      pool as never,
    )).resolves.toBe("ok");
    expect(query.mock.calls.some(([sql, params]) => String(sql).includes("update users set email") && params[1] === "new@example.test")).toBe(true);
    expect(release).toHaveBeenCalled();
  });

  it("does not update users when the request is superseded", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{
        id: "8",
        user_id: "3",
        target_email: "new@example.test",
        generation: "1",
        expires_at: "2026-08-05T13:30:00Z",
        confirmed_at: null,
        cancelled_at: null,
        email_change_generation: "2",
      }] })
      .mockResolvedValueOnce({});
    await expect(consumeEmailChange(
      { token: "x".repeat(32), now: new Date("2026-08-05T13:00:00Z") },
      pool as never,
    )).resolves.toBe("used");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("update users set email"))).toBe(false);
  });
});
