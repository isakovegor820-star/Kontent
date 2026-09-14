import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  latest: vi.fn(),
  getPool: vi.fn(),
  session: vi.fn(),
}));

vi.mock("@/lib/typography-service", () => ({
  getLatestTypographyRunForDraft: mocks.latest,
}));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));

import { GET } from "./route";

describe("GET /api/typography/runs/latest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ id: 5 });
    mocks.getPool.mockReturnValue({ query: vi.fn() });
    mocks.latest.mockResolvedValue({ id: 72, currentReview: true });
  });

  it("delegates project selection and draft authorization to the server service", async () => {
    const pool = { query: vi.fn() };
    mocks.getPool.mockReturnValue(pool);
    const response = await GET(new NextRequest("http://localhost/api/typography/runs/latest?draftId=41"));

    expect(response.status).toBe(200);
    expect(mocks.latest).toHaveBeenCalledWith({ db: pool, actorUserId: 5, draftId: 41 });
    await expect(response.json()).resolves.toMatchObject({ ok: true, run: { id: 72 } });
  });

  it("rejects an invalid draft before database access", async () => {
    const response = await GET(new NextRequest("http://localhost/api/typography/runs/latest?draftId=other"));
    expect(response.status).toBe(400);
    expect(mocks.getPool).not.toHaveBeenCalled();
    expect(mocks.latest).not.toHaveBeenCalled();
  });

  it("requires an authenticated session", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await GET(new NextRequest("http://localhost/api/typography/runs/latest?draftId=41"));
    expect(response.status).toBe(401);
    expect(mocks.latest).not.toHaveBeenCalled();
  });
});
