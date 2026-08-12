import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPool: vi.fn(() => ({ query: vi.fn() })),
  session: vi.fn(),
  origin: vi.fn(),
  rate: vi.fn(),
  rateResponse: vi.fn(),
  authorize: vi.fn(),
  list: vi.fn(),
  markOne: vi.fn(),
  markAll: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.origin }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.rate,
  rateLimitResponse: mocks.rateResponse,
}));
vi.mock("@/lib/project-notifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-notifications")>();
  return {
    ...actual,
    authorizeProjectNotificationScope: mocks.authorize,
    listProjectNotifications: mocks.list,
    markProjectNotificationRead: mocks.markOne,
    markAllProjectNotificationsRead: mocks.markAll,
  };
});

import { ProjectAccessError } from "@/lib/project-permissions";
import { ProjectNotificationError } from "@/lib/project-notifications";
import { GET } from "./route";
import { POST as markOne } from "./[id]/read/route";
import { POST as markAll } from "./read-all/route";

const allowedRate = { allowed: true, limit: 720, remaining: 719, retryAfter: 0 };
const scope = { projectId: 23, userId: 5, role: "author" as const };

function getRequest(query = "") {
  return new NextRequest(`http://localhost/api/project-notifications${query}`);
}

function postRequest(path: string, body?: string) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: {
      origin: "http://localhost",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body,
  });
}

describe("project notification routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ id: 5 });
    mocks.origin.mockReturnValue(true);
    mocks.rate.mockResolvedValue(allowedRate);
    mocks.rateResponse.mockImplementation(() => NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 }));
    mocks.authorize.mockResolvedValue(scope);
    mocks.list.mockResolvedValue({
      projectId: 23,
      notifications: [],
      unreadCount: 0,
      nextCursor: null,
      hasMore: false,
    });
    mocks.markOne.mockResolvedValue({
      projectId: 23,
      notificationId: 17,
      readAt: "2026-08-12T10:00:00.000Z",
      unreadCount: 0,
    });
    mocks.markAll.mockResolvedValue({ projectId: 23, markedCount: 4, unreadCount: 0 });
  });

  it("requires authentication before resolving a selected project", async () => {
    mocks.session.mockResolvedValue(null);
    const response = await GET(getRequest());
    expect(response.status).toBe(401);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });

  it("rejects unknown, repeated and oversized list input before authorization", async () => {
    const foreign = await GET(getRequest("?projectId=999"));
    expect(foreign.status).toBe(422);
    expect(mocks.authorize).not.toHaveBeenCalled();

    const repeated = await GET(getRequest("?limit=10&limit=20"));
    expect(repeated.status).toBe(422);

    const oversized = await GET(getRequest(`?before=${"9".repeat(520)}`));
    expect(oversized.status).toBe(422);
  });

  it("lists through the server-selected scope with user and project rate limits", async () => {
    const pool = { query: vi.fn() };
    mocks.getPool.mockReturnValue(pool);
    const response = await GET(getRequest("?limit=25&before=91&unread=true"));

    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(pool, 5);
    expect(mocks.rate).toHaveBeenNthCalledWith(
      1,
      "project-notifications:read:user:5",
      720,
      3_600,
      { failureMode: "closed" },
    );
    expect(mocks.rate).toHaveBeenNthCalledWith(
      2,
      "project-notifications:read:project:23",
      3_600,
      3_600,
      { failureMode: "closed" },
    );
    expect(mocks.list).toHaveBeenCalledWith(pool, scope, {
      limit: 25,
      beforeId: 91,
      unreadOnly: true,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("fails closed when either inbox rate limit denies the request", async () => {
    mocks.rate
      .mockResolvedValueOnce(allowedRate)
      .mockResolvedValueOnce({ allowed: false, limit: 3_600, remaining: 0, retryAfter: 10 });
    const response = await GET(getRequest());
    expect(response.status).toBe(429);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("maps lost project membership to one non-enumerating access error", async () => {
    mocks.authorize.mockRejectedValue(new ProjectAccessError("membership_required"));
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "access_denied" });
  });

  it("checks trusted origin before session lookup or a mark-one mutation", async () => {
    mocks.origin.mockReturnValue(false);
    const response = await markOne(postRequest("/api/project-notifications/17/read"), {
      params: Promise.resolve({ id: "17" }),
    });
    expect(response.status).toBe(403);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.markOne).not.toHaveBeenCalled();
  });

  it("accepts no mutation body and marks only the selected-project recipient", async () => {
    const pool = { query: vi.fn() };
    mocks.getPool.mockReturnValue(pool);
    const response = await markOne(postRequest("/api/project-notifications/17/read"), {
      params: Promise.resolve({ id: "17" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(pool, 5);
    expect(mocks.rate).toHaveBeenNthCalledWith(
      1,
      "project-notifications:write:user:5",
      240,
      3_600,
      { failureMode: "closed" },
    );
    expect(mocks.rate).toHaveBeenNthCalledWith(
      2,
      "project-notifications:write:project:23",
      1_200,
      3_600,
      { failureMode: "closed" },
    );
    expect(mocks.markOne).toHaveBeenCalledWith(pool, scope, 17);
  });

  it("accepts a framework-created empty stream when the browser declares zero bytes", async () => {
    const pool = { query: vi.fn() };
    mocks.getPool.mockReturnValue(pool);
    const request = postRequest("/api/project-notifications/17/read");
    Object.defineProperty(request, "body", { configurable: true, value: new ReadableStream() });
    request.headers.set("content-length", "0");

    const response = await markOne(request, { params: Promise.resolve({ id: "17" }) });

    expect(response.status).toBe(200);
    expect(mocks.markOne).toHaveBeenCalledWith(pool, scope, 17);
  });

  it("rejects all mark-one bodies and invalid route ids before project mutation", async () => {
    const withBody = await markOne(postRequest("/api/project-notifications/17/read", "{}"), {
      params: Promise.resolve({ id: "17" }),
    });
    expect(withBody.status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();

    const invalidId = await markOne(postRequest("/api/project-notifications/bad/read"), {
      params: Promise.resolve({ id: "bad" }),
    });
    expect(invalidId.status).toBe(422);
    expect(mocks.markOne).not.toHaveBeenCalled();
  });

  it("does not reveal whether a notification belongs to another project", async () => {
    mocks.markOne.mockRejectedValue(new ProjectNotificationError("notification_not_found"));
    const response = await markOne(postRequest("/api/project-notifications/999/read"), {
      params: Promise.resolve({ id: "999" }),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "notification_not_found" });
  });

  it("checks origin, authorization and both rate limits before marking all", async () => {
    const pool = { query: vi.fn() };
    mocks.getPool.mockReturnValue(pool);
    const response = await markAll(postRequest("/api/project-notifications/read-all"));
    expect(response.status).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(pool, 5);
    expect(mocks.rate).toHaveBeenCalledTimes(2);
    expect(mocks.markAll).toHaveBeenCalledWith(pool, scope);
    await expect(response.json()).resolves.toMatchObject({ markedCount: 4, unreadCount: 0 });
  });
});
