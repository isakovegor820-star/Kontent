import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  listLegalSourceState: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/legal-source-service", () => ({ listLegalSourceState: mocks.listLegalSourceState }));

import { GET } from "./route";

describe("GET /api/legal-sources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.listLegalSourceState.mockResolvedValue({
      providers: [],
      connections: [],
      fragmentCounts: { law: 2 },
    });
  });

  it("shows ConsultantPlus and GARANT public RSS under the legal category", async () => {
    const response = await GET(new NextRequest("http://localhost/api/legal-sources"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBeTruthy();
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      category: "Юридические источники",
      paidIntegrationsStatus: "not_configured",
      publicSources: [
        { id: "consultant", access: "public_rss", category: "Юридические источники" },
        { id: "garant", access: "public_rss", category: "Юридические источники" },
      ],
      fragmentCounts: { law: 2 },
      requestId: expect.any(String),
    });
  });

  it("requires an authenticated account", async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/legal-sources"));
    expect(response.status).toBe(401);
    expect(mocks.listLegalSourceState).not.toHaveBeenCalled();
  });
});
