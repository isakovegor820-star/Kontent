import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  getPool: vi.fn(),
  session: vi.fn(),
  origin: vi.fn(),
  rate: vi.fn(),
}));

vi.mock("@/lib/brand-dictionary-service", () => ({
  createProjectBrandDictionaryEntry: mocks.create,
  getProjectBrandDictionary: mocks.get,
}));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.origin }));
vi.mock("@/lib/rate-limit", async (original) => ({
  ...await original<typeof import("@/lib/rate-limit")>(),
  checkRateLimit: mocks.rate,
}));

import { GET, POST } from "./route";

function getRequest() {
  return new NextRequest("http://localhost/api/brand-dictionary");
}

function postRequest(origin = "http://localhost") {
  return new NextRequest("http://localhost/api/brand-dictionary", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({
      expectedDictionaryVersion: 1,
      kind: "canonical",
      term: "legal tech",
      replacement: "LegalTech",
      expansion: null,
      caseSensitive: false,
    }),
  });
}

describe("/api/brand-dictionary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.origin.mockReturnValue(true);
    mocks.session.mockResolvedValue({ id: 5 });
    mocks.rate.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, retryAfter: 0 });
    mocks.getPool.mockReturnValue({ query: vi.fn(), connect: vi.fn() });
    mocks.get.mockResolvedValue({ projectId: 23, version: 1, entries: [], updatedAt: null });
    mocks.create.mockResolvedValue({
      projectId: 23,
      dictionaryVersion: 2,
      entry: { id: 7, kind: "canonical", term: "legal tech", replacement: "LegalTech" },
    });
  });

  it("loads a dictionary through the project.read service guard", async () => {
    const pool = { query: vi.fn(), connect: vi.fn() };
    mocks.getPool.mockReturnValue(pool);
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    expect(mocks.get).toHaveBeenCalledWith(pool, 5);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      dictionary: { projectId: 23, version: 1 },
    });
  });

  it("checks trusted origin before authentication and project mutation", async () => {
    mocks.origin.mockReturnValue(false);
    const response = await POST(postRequest("https://attacker.example"));
    expect(response.status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rate-limits and forwards a strict dictionary mutation contract", async () => {
    const pool = { query: vi.fn(), connect: vi.fn() };
    mocks.getPool.mockReturnValue(pool);
    const response = await POST(postRequest());
    expect(response.status).toBe(201);
    expect(mocks.rate).toHaveBeenCalledWith("brand-dictionary:write:user:5", 60, 3_600, {
      failureMode: "closed",
    });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      pool,
      actorUserId: 5,
      expectedDictionaryVersion: 1,
      kind: "canonical",
    }));
  });
});
