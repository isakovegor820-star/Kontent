import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
  probeRedisAndPublicationWorker: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/readiness-probes", () => ({
  probeRedisAndPublicationWorker: mocks.probeRedisAndPublicationWorker,
}));

import { GET } from "./route";

describe("GET /api/bot/link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TG_BOT_USERNAME", "aurora_bot");
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.query.mockResolvedValue({ rows: [{ tg_chat_id: "123" }] });
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
});
