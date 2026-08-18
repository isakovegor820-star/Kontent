import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
  createLegacyBotLink: vi.fn(),
  probeRedisAndPublicationWorker: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/bot-connection.mjs", () => ({
  createLegacyBotLink: mocks.createLegacyBotLink,
  normalizeTelegramBotUsername: (value: unknown) => {
    const username = String(value || "").replace(/^@/u, "").trim();
    return /^[A-Za-z0-9_]{5,32}$/u.test(username) ? username : null;
  },
}));
vi.mock("@/lib/readiness-probes", () => ({
  probeRedisAndPublicationWorker: mocks.probeRedisAndPublicationWorker,
}));

import { GET, POST } from "./route";

describe("GET /api/bot/link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TG_BOT_USERNAME", "aurora_bot");
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.query.mockResolvedValue({ rows: [{ tg_chat_id: "123" }] });
    mocks.createLegacyBotLink.mockResolvedValue({
      code: "a".repeat(32),
      expiresInMinutes: 15,
    });
    mocks.probeRedisAndPublicationWorker.mockResolvedValue({
      redis: "up",
      publicationWorker: "up",
      telegramPolling: "down",
    });
  });

  it("returns an explicit polling conflict instead of a generic disconnect", async () => {
    mocks.probeRedisAndPublicationWorker.mockResolvedValue({
      redis: "up",
      publicationWorker: "up",
      telegramPolling: "conflict",
    });

    const response = await GET(new NextRequest("http://localhost/api/bot/link"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      linked: true,
      botStatus: "conflict",
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it("keeps durable chat linkage separate from live Telegram polling", async () => {
    const response = await GET(new NextRequest("http://localhost/api/bot/link"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      linked: true,
      bot: "aurora_bot",
      botStatus: "down",
    });
  });

  it("does not probe runtime state before authentication", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await GET(new NextRequest("http://localhost/api/bot/link"));

    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.probeRedisAndPublicationWorker).not.toHaveBeenCalled();
  });

  it("creates a validated, atomic one-time link", async () => {
    const response = await POST(new NextRequest("http://localhost/api/bot/link", {
      method: "POST",
      headers: { origin: "http://localhost" },
    }));

    expect(response.status).toBe(200);
    expect(mocks.createLegacyBotLink).toHaveBeenCalledWith(
      expect.objectContaining({ query: mocks.query }),
      { userId: 7 },
    );
    await expect(response.json()).resolves.toEqual({
      ok: true,
      url: `https://t.me/aurora_bot?start=${"a".repeat(32)}`,
      expiresInMin: 15,
    });
  });

  it("does not create a broken link for an invalid configured bot username", async () => {
    vi.stubEnv("TG_BOT_USERNAME", "https://t.me/not-a-username");
    const response = await POST(new NextRequest("http://localhost/api/bot/link", {
      method: "POST",
      headers: { origin: "http://localhost" },
    }));

    expect(response.status).toBe(503);
    expect(mocks.createLegacyBotLink).not.toHaveBeenCalled();
  });
});
