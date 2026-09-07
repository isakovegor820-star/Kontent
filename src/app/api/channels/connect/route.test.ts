import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  requireProjectPermission: vi.fn(),
  query: vi.fn(),
  add: vi.fn(),
  saveVerifiedTelegramChannel: vi.fn(),
  createTelegramChannelProof: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/rate-limit", async (original) => ({ ...await original<typeof import("@/lib/rate-limit")>(), checkRateLimit: mocks.checkRateLimit }));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return {
    ...actual,
    requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
    requireProjectPermission: mocks.requireProjectPermission,
  };
});
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.add }) }));
vi.mock("@/lib/telegram-channel-connect.mjs", () => ({
  saveVerifiedTelegramChannel: mocks.saveVerifiedTelegramChannel,
  createTelegramChannelProof: mocks.createTelegramChannelProof,
}));

import { POST } from "./route";

const previousToken = process.env.TG_BOT_TOKEN;

function request() {
  return new NextRequest("http://localhost/api/channels/connect", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ handle: "@team" }),
  });
}

describe("POST /api/channels/connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TG_BOT_TOKEN = "12345:test-token";
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.query.mockResolvedValue({ rows: [{ tg_chat_id: "123" }] });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.createTelegramChannelProof.mockResolvedValue({ state: "ready", proofId: "11111111-1111-4111-8111-111111111111", actorId: 123 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 12 });
    mocks.requireProjectPermission.mockResolvedValue({ projectId: 12 });
    mocks.add.mockResolvedValue({ id: "discover" });
    mocks.saveVerifiedTelegramChannel.mockResolvedValue({ state: "connected", channelId: 41 });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { id: -1001, type: "channel", title: "Team", username: "team" },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        result: { status: "administrator", can_post_messages: true },
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { status: "creator" } }))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousToken === undefined) delete process.env.TG_BOT_TOKEN;
    else process.env.TG_BOT_TOKEN = previousToken;
  });

  it("refuses a caller without a Telegram actor even when the shared bot can publish", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.saveVerifiedTelegramChannel).not.toHaveBeenCalled();
  });

  it("passes the explicitly authorized project to the atomic connection service", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      7,
      "project.manage",
    );
    expect(mocks.saveVerifiedTelegramChannel).toHaveBeenCalledWith(
      expect.anything(),
      {
        userId: 7,
        projectId: 12,
        actorId: 123,
        proofId: "11111111-1111-4111-8111-111111111111",
        chat: { id: -1001, type: "channel", title: "Team", username: "team" },
      },
    );
  });

  it("rejects a non-manager before calling Telegram", async () => {
    const { ProjectAccessError } = await import("@/lib/project-permissions");
    mocks.requireSelectedProjectPermission.mockRejectedValueOnce(new ProjectAccessError("permission_denied"));

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.saveVerifiedTelegramChannel).not.toHaveBeenCalled();
  });

  it.each(["member", "left", "kicked"])("rejects a Telegram actor with status %s", async (status) => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, result: { id: -1001, type: "channel" } }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { status: "administrator", can_post_messages: true } }))
      .mockResolvedValueOnce(Response.json({ ok: true, result: { status } })));
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(mocks.saveVerifiedTelegramChannel).not.toHaveBeenCalled();
  });

  it("fails closed before provider requests when limiter is unavailable", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({ allowed: false, unavailable: true, retryAfter: 30, limit: 10, remaining: 0 });
    expect((await POST(request())).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a temporary provider error for network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network unavailable")));
    const response = await POST(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "provider_unavailable" });
    expect(mocks.saveVerifiedTelegramChannel).not.toHaveBeenCalled();
  });

  it("supplies a shared cancellation signal to every provider check", async () => {
    expect((await POST(request())).status).toBe(200);
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1][1]?.signal).toBe(calls[0][1]?.signal);
  });

  it("keeps a channel in its existing Aurora project", async () => {
    mocks.saveVerifiedTelegramChannel.mockResolvedValueOnce({ state: "taken" });

    const response = await POST(request());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "taken" });
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
