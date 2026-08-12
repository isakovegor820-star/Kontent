import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { GET } from "./route";

function request(headers: HeadersInit = {}) {
  return new NextRequest("http://localhost/api/settings/profile/avatar-assets/91", { headers });
}

const context = { params: Promise.resolve({ id: "91" }) };

describe("profile avatar asset delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
  });

  it("serves only the owner's global avatar as a private image", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      mime_type: "image/webp",
      file_name: "avatar.webp",
      sha256: "abc123",
      data: Buffer.from("avatar"),
    }] });

    const response = await GET(request(), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("etag")).toBe('"abc123"');
    await expect(response.arrayBuffer()).resolves.toEqual(
      Uint8Array.from(Buffer.from("avatar")).buffer,
    );
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("from user_avatar_assets asset"),
      [91, 7],
    );
    expect(mocks.query.mock.calls[0]?.[0]).toContain("asset.user_id = $2");
    expect(mocks.query.mock.calls[0]?.[0]).not.toContain("selected_project_id");
  });

  it("honors the asset ETag without returning the private bytes again", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      mime_type: "image/webp",
      file_name: "avatar.webp",
      sha256: "abc123",
      data: Buffer.from("avatar"),
    }] });

    const response = await GET(request({ "if-none-match": '"abc123"' }), context);

    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe('"abc123"');
    expect(await response.text()).toBe("");
  });

  it("does not disclose whether an inaccessible avatar exists", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] });

    const response = await GET(request(), context);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "not_found" });
  });
});
