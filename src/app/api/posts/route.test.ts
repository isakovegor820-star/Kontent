import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { GET } from "./route";

function membership(projectId = 44, role = "publisher") {
  return {
    rows: [{ project_id: String(projectId), user_id: "91", role, version: "4" }],
    rowCount: 1,
  };
}

describe("GET /api/posts project isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 91 });
  });

  it("returns project posts to a member without restricting them to the creating user", async () => {
    mocks.query
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce({
        rows: [{ id: "501", text: "Изменения в договорной работе", channel_id: "73" }],
        rowCount: 1,
      });

    const response = await GET(new NextRequest("http://localhost/api/posts"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      posts: [{
        id: 501,
        channel_id: 73,
        text: "Изменения в договорной работе",
      }],
    });
    const [dataSql, dataParams] = mocks.query.mock.calls[1];
    const normalizedSql = String(dataSql).replace(/\s+/g, " ");
    expect(normalizedSql).toContain("where p.project_id = $1");
    expect(normalizedSql).not.toContain("where p.user_id = $1");
    expect(normalizedSql).toContain("c.project_id = p.project_id");
    expect(normalizedSql).toContain("operation.project_id = p.project_id");
    expect(normalizedSql).toContain("post_author.id = p.user_id");
    expect(normalizedSql).toContain("author_user_id");
    expect(dataParams).toEqual([44]);
  });

  it("normalizes PostgreSQL bigint identities for strict client-side channel matching", async () => {
    mocks.query
      .mockResolvedValueOnce(membership())
      .mockResolvedValueOnce({
        rows: [{
          id: "501",
          author_user_id: "91",
          channel_id: "73",
          tg_message_id: "812",
          vk_post_id: null,
          vk_group_id: null,
          publication_operation_id: "902",
        }],
        rowCount: 1,
      });

    const response = await GET(new NextRequest("http://localhost/api/posts"));

    await expect(response.json()).resolves.toMatchObject({
      posts: [{
        id: 501,
        author_user_id: 91,
        channel_id: 73,
        tg_message_id: 812,
        vk_post_id: null,
        vk_group_id: null,
        publication_operation_id: 902,
      }],
    });
  });

  it("never runs the post query for a user outside the selected project", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await GET(new NextRequest("http://localhost/api/posts"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "access_denied" });
    expect(mocks.query).toHaveBeenCalledOnce();
  });

  it("returns 401 before project authorization when the session is missing", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);

    const response = await GET(new NextRequest("http://localhost/api/posts"));

    expect(response.status).toBe(401);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
