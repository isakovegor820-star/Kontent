import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  assertLibraryItemOwnership: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/library-registry", () => ({ assertLibraryItemOwnership: mocks.assertLibraryItemOwnership }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/library/state", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/library/state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.assertLibraryItemOwnership.mockResolvedValue(true);
    mocks.query.mockResolvedValue({ rows: [{ rating: 4, viewed_at: "2026-08-05T10:00:00Z" }] });
  });

  it("rejects ratings outside the distinct 1–5 user scale", async () => {
    const response = await POST(request({ itemType: "reference", itemId: 5, channelId: 11, rating: 87 }));
    expect(response.status).toBe(422);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("validates ownership before upserting viewed/rating state", async () => {
    const response = await POST(request({ itemType: "reference", itemId: 5, channelId: 11, rating: 4, viewed: true }));
    expect(response.status).toBe(200);
    expect(mocks.assertLibraryItemOwnership).toHaveBeenCalledWith(7, 11, "reference", 5);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("on conflict"), [7, 11, "reference", 5, 4, true]);
  });

  it("does not disclose another user's item", async () => {
    mocks.assertLibraryItemOwnership.mockResolvedValue(false);
    const response = await POST(request({ itemType: "idea", itemId: 9, channelId: 11, viewed: true }));
    expect(response.status).toBe(404);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
