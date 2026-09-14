import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
  renderLibraryExport: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/library-export.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/library-export.mjs")>();
  return { ...actual, renderLibraryExport: mocks.renderLibraryExport };
});

import { GET } from "./route";

describe("GET /api/library/exports/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.query.mockResolvedValue({ rows: [{ snapshot: { exportedAt: "x", activeFilters: {}, formulaVersion: "v", items: [] } }] });
    mocks.renderLibraryExport.mockResolvedValue({ bytes: Buffer.from("file"), contentType: "text/csv", extension: "csv" });
  });

  it("loads the user-owned snapshot and renders the requested format", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/library/exports/41?format=csv"),
      { params: Promise.resolve({ id: "41" }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("aurora-ideas-41.csv");
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("expires_at > now()"), [41, 7]);
  });

  it("rejects unsupported formats", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/library/exports/41?format=xml"),
      { params: Promise.resolve({ id: "41" }) },
    );
    expect(response.status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
