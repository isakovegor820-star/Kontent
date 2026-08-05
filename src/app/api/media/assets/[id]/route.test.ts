import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { GET } from "./route";

function request(id = "41") {
  return GET(
    new NextRequest(`http://localhost/api/media/assets/${id}`),
    { params: Promise.resolve({ id }) },
  );
}

describe("GET /api/media/assets/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
  });

  it("serves only the authenticated owner's signature-validated media types", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    mocks.query.mockResolvedValue({
      rows: [{ data: png, mime_type: "image/png", file_name: "aurora.png", sha256: "abc" }],
    });

    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("user_id = $2"), [41, 7]);
  });

  it("refuses an unsafe stored MIME type and returns a correlation id", async () => {
    mocks.query.mockResolvedValue({
      rows: [{
        data: Buffer.from("<script>"),
        mime_type: "text/html",
        file_name: "unsafe.html",
        sha256: "def",
      }],
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await request();

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "server", requestId: expect.any(String) });
    expect(error).toHaveBeenCalledWith("[media-api]", expect.objectContaining({
      event: "asset_read_failed",
      assetId: 41,
      errorName: "Error",
    }));
    error.mockRestore();
  });
});
