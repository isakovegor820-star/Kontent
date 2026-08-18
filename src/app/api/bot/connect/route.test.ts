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

  afterEach(() => vi.unstubAllEnvs());

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

  it("rejects a cross-site browser mutation before reading the session", async () => {
    const response = await POST(request(
      { action: "inspect", token: "a".repeat(43) },
      { origin: "https://attacker.example", host: "localhost" },
    ));
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });
});
