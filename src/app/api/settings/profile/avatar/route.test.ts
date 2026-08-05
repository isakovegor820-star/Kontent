import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import sharp from "sharp";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { POST } from "./route";

function request(form: FormData, origin = "http://localhost") {
  return new NextRequest("http://localhost/api/settings/profile/avatar", {
    method: "POST",
    headers: { origin },
    body: form,
  });
}

describe("profile avatar upload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
  });

  it("normalizes and stores an owned image asset", async () => {
    const source = await sharp({
      create: { width: 640, height: 480, channels: 3, background: "#7088dd" },
    }).png().toBuffer();
    const form = new FormData();
    form.set("avatar", new File([source], "portrait.png", { type: "image/png" }));
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "91" }] });

    const response = await POST(request(form));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      avatar: "/api/media/assets/91",
      mimeType: "image/webp",
    });
    expect(mocks.query.mock.calls[1]?.[1]?.[0]).toBe(7);
    expect(mocks.query.mock.calls[1]?.[1]?.[3]).toEqual(expect.any(Number));
    expect(Buffer.isBuffer(mocks.query.mock.calls[1]?.[1]?.[4])).toBe(true);
  });

  it("rejects an unsupported file and an untrusted origin", async () => {
    const bad = new FormData();
    bad.set("avatar", new File(["GIF89a"], "avatar.gif", { type: "image/gif" }));
    const unsupported = await POST(request(bad));
    expect(unsupported.status).toBe(422);
    await expect(unsupported.json()).resolves.toMatchObject({ error: "unsupported_type" });

    const crossOrigin = await POST(request(new FormData(), "https://evil.example"));
    expect(crossOrigin.status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
