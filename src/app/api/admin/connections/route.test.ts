import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ session: vi.fn(), load: vi.fn(), pool: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/db", () => ({ getPool: mocks.pool }));
vi.mock("@/lib/admin-operations-data", () => ({ loadAdminConnections: mocks.load }));
// Deliberately use the real allowlist/verified-email guard. The companion SQL suite
// additionally executes the real session guard and exact data loader.
import { GET } from "./route";
const request = () => new NextRequest("http://localhost/api/admin/connections?page=2&q=fixture");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("AURORA_ADMIN_USER_IDS", "71");
  vi.stubEnv("AURORA_ADMIN_EMAILS", "ops@example.test");
  mocks.pool.mockReturnValue({ query: vi.fn() });
  mocks.load.mockResolvedValue({ items: [], pagination: { total: 0 } });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/admin/connections real admin policy", () => {
  it("rejects an absent or session-filtered blocked identity before data access", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(mocks.pool).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each([
    { id: 72, email: "owner@example.test", email_verified: true },
    { id: 72, email: "ops@example.test", email_verified: false },
    { id: 72, email: "ops@example.test" },
  ])("denies a live nonadmin or unproved allowlisted email: %j", async (user) => {
    mocks.session.mockResolvedValue(user);
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "access_denied" });
    expect(mocks.pool).not.toHaveBeenCalled(); expect(mocks.load).not.toHaveBeenCalled();
  });
  it.each([
    { id: 71, email: null, email_verified: false },
    { id: 72, email: "ops@example.test", email_verified: true },
  ])("allows an explicit server ID or verified email grant: %j", async (user) => {
    mocks.session.mockResolvedValue(user);
    const response = await GET(request());
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ items: [], pagination: { total: 0 } });
    expect(mocks.load).toHaveBeenCalledOnce();
    expect(mocks.load.mock.calls[0][1].get("q")).toBe("fixture");
  });
  it("returns a bounded unavailable error without exposing internal data", async () => {
    mocks.session.mockResolvedValue({ id: 71 });
    mocks.load.mockRejectedValue(new Error("credential-canary=do-not-return"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "admin_data_unavailable" });
  });
});
