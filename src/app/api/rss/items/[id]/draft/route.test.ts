import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  createDraftForUser: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: () => true }));
vi.mock("@/lib/server-drafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server-drafts")>();
  return { ...actual, createDraftForUser: mocks.createDraftForUser };
});

import { POST } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 5 });
  mocks.createDraftForUser.mockResolvedValue({
    created: true,
    draft: { id: 44, purpose: "source_context", origin: "rss" },
  });
});

describe("POST /api/rss/items/:id/draft", () => {
  it("creates a stable server-owned source context for the exact item and channel", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/rss/items/88/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: 11, variant: "expert" }),
      }),
      { params: Promise.resolve({ id: "88" }) },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      draft: { id: 44, purpose: "source_context", origin: "rss" },
    });
    expect(mocks.createDraftForUser).toHaveBeenCalledWith(5, expect.objectContaining({
      clientKey: "rss_item_source:88:channel:11:variant:expert",
      origin: "rss",
      sourceRef: { kind: "rss", id: "88", label: "Юридический инфоповод" },
      channelIds: [11],
    }));
  });

  it("rejects an invalid channel before touching draft storage", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/rss/items/88/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: "11" }),
      }),
      { params: Promise.resolve({ id: "88" }) },
    );

    expect(response.status).toBe(422);
    expect(mocks.createDraftForUser).not.toHaveBeenCalled();
  });

  it("rejects an unknown content variant", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/rss/items/88/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: 11, variant: "copied" }),
      }),
      { params: Promise.resolve({ id: "88" }) },
    );

    expect(response.status).toBe(422);
    expect(mocks.createDraftForUser).not.toHaveBeenCalled();
  });
});
