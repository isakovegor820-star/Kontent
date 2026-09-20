import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  inspect: vi.fn(),
  confirm: vi.fn(),
  pool: {},
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => mocks.pool }));
vi.mock("@/lib/bot-connection.mjs", () => ({
  inspectBotConnectionSession: mocks.inspect,
  confirmBotConnectionSession: mocks.confirm,
  maskBotAccountEmail: (value: string) => `masked:${value}`,
  normalizeTelegramBotUsername: (value: unknown) => {
    const username = String(value || "").replace(/^@/u, "").trim();
    return /^[A-Za-z0-9_]{5,32}$/u.test(username) ? username : null;
  },
}));

import { POST } from "./route";

function request(body: unknown, headers?: Record<string, string>) {
  return new NextRequest("http://localhost/api/bot/connect", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/bot/connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TG_BOT_USERNAME", "aurora_bot");
    mocks.getSessionUser.mockResolvedValue(null);
    mocks.inspect.mockResolvedValue({
      state: "pending",
      telegram: { displayName: "Анна", username: "anna" },
      moveRequired: false,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("inspects a secret without requiring login or exposing account data", async () => {
    mocks.inspect.mockResolvedValue({
      state: "pending",
      telegram: {
        userId: 123,
        chatId: 456,
        displayName: "Анна",
        username: "anna",
      },
      confirmedByUserId: 7,
      expiresAt: "2026-08-18T12:15:00.000Z",
      moveRequired: false,
    });
    const response = await POST(request({ action: "inspect", token: "a".repeat(43) }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      state: "pending",
      authenticated: false,
      account: null,
      bot: "aurora_bot",
      telegram: { displayName: "Анна", username: "anna" },
    });
    expect(body.telegram).not.toHaveProperty("userId");
    expect(body.telegram).not.toHaveProperty("chatId");
    expect(body).not.toHaveProperty("confirmedByUserId");
  });

  it("requires an authenticated Aurora account for confirmation", async () => {
    const response = await POST(request({ action: "confirm", token: "a".repeat(43) }));
    expect(response.status).toBe(401);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown", { state: "invalid" }],
    ["expired", {
      state: "expired",
      expiresAt: "2026-08-18T11:59:59.000Z",
      telegram: { displayName: "Анна", username: "anna" },
    }],
    ["revoked", {
      state: "revoked",
      expiresAt: "2026-08-18T12:15:00.000Z",
      telegram: { displayName: "Анна", username: "anna" },
    }],
    ["consumed by another account", {
      state: "confirmed",
      confirmedByUserId: 7,
      expiresAt: "2026-08-18T12:15:00.000Z",
      telegram: { displayName: "Анна", username: "anna" },
    }],
  ])("returns one privacy-preserving shape for an %s token", async (_label, inspection) => {
    mocks.inspect.mockResolvedValue(inspection);
    const response = await POST(request({ action: "inspect", token: "a".repeat(43) }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      state: "unavailable",
      authenticated: false,
      bot: "aurora_bot",
    });
  });

  it("shows a consumed token as confirmed only to the account that consumed it", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 7, name: "Егор", email: "egor@example.com" });
    mocks.inspect.mockResolvedValue({
      state: "confirmed",
      confirmedByUserId: 7,
      telegram: { displayName: "Анна", username: "anna" },
    });
    const response = await POST(request({ action: "inspect", token: "a".repeat(43) }));
    await expect(response.json()).resolves.toMatchObject({ ok: true, state: "confirmed" });
  });

  it("does not disclose token or requester account details to another authenticated account", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 8, name: "Лев", email: "lev@example.com" });
    mocks.inspect.mockResolvedValue({
      state: "confirmed",
      confirmedByUserId: 7,
      expiresAt: "2026-08-18T12:15:00.000Z",
      telegram: { displayName: "Анна", username: "anna" },
      moveRequired: true,
    });
    const response = await POST(request({ action: "inspect", token: "a".repeat(43) }));
    expect(await response.json()).toEqual({
      ok: true,
      state: "unavailable",
      authenticated: true,
      bot: "aurora_bot",
    });
  });

  it.each(["invalid", "expired", "revoked", "used"])(
    "normalizes the %s confirmation result without echoing internal state",
    async (state) => {
      mocks.getSessionUser.mockResolvedValue({ id: 8, name: "Лев", email: "lev@example.com" });
      mocks.confirm.mockResolvedValue({
        state,
        telegramChatId: 123,
        chatLinkedToAnotherAccount: true,
      });
      const response = await POST(request({ action: "confirm", token: "a".repeat(43) }));
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ ok: false, error: "link_unavailable" });
    },
  );

  it("requires explicit consent before moving an existing connection", async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 7, name: "Егор", email: "egor@example.com" });
    mocks.confirm.mockResolvedValue({
      state: "move_required",
      chatLinkedToAnotherAccount: true,
      accountLinkedToAnotherChat: false,
    });
    const response = await POST(request({ action: "confirm", token: "a".repeat(43), allowMove: false }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "move_required" });
  });

  it("sends the confirmation through the configured Telegram API without blocking success", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("TG_BOT_TOKEN", "telegram-test-token");
    vi.stubEnv("TG_API_URL", "https://telegram-gateway.example/");
    mocks.getSessionUser.mockResolvedValue({ id: 7, name: "Егор", email: "egor@example.com" });
    mocks.confirm.mockResolvedValue({ state: "connected", telegramChatId: 123, moved: false });

    const response = await POST(request({ action: "confirm", token: "a".repeat(43) }));

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledWith(
      "https://telegram-gateway.example/bottelegram-test-token/sendMessage",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects a cross-site browser mutation before reading the session", async () => {
    const response = await POST(request(
      { action: "inspect", token: "a".repeat(43) },
      { origin: "https://attacker.example", host: "localhost" },
    ));
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });
});
