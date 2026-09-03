import { describe, expect, it, vi } from "vitest";

import { normalizeAdminSearchQuery, searchAdminEntities } from "./admin-search";

describe("admin search", () => {
  it("normalises and refuses too-short queries without touching the database", async () => {
    expect(normalizeAdminSearchQuery("  Игорь   Кузнецов ")).toBe("Игорь Кузнецов");
    expect(normalizeAdminSearchQuery("x".repeat(200)).length).toBe(120);
    const query = vi.fn();
    await expect(searchAdminEntities({ query } as never, "a")).resolves.toEqual({ query: "a", users: [], projects: [], posts: [] });
    expect(query).not.toHaveBeenCalled();
  });

  it("matches numeric input as ids, escapes LIKE wildcards and never returns full post text", async () => {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("from users")) return { rows: [{ id: 42, title: "Игорь", email: "i@example.com", blocked: true, projects: 2 }] };
      if (sql.includes("from projects")) return { rows: [{ id: 42, title: "FitLab", is_archived: false, members: 3, channels: 2 }] };
      void params;
      return { rows: [{ id: 42, status: "failed", title: "Пост", project: "FitLab", network: "tg" }] };
    });
    const result = await searchAdminEntities({ query } as never, "42");
    expect(query.mock.calls[0][1]).toEqual([42, "%42%", 6]);
    expect(result.users[0]).toMatchObject({ kind: "user", id: 42, badge: "заблокирован" });
    expect(result.projects[0]).toMatchObject({ kind: "project", id: 42, subtitle: "3 участников · 2 каналов" });
    expect(result.posts[0]).toMatchObject({ kind: "post", id: 42, badge: "failed" });
    expect(query.mock.calls.every(([sql]) => String(sql).includes("limit $3"))).toBe(true);
    expect(String(query.mock.calls[2][0])).toContain("left(regexp_replace(post.text");
    await searchAdminEntities({ query } as never, "50%_off");
    expect(query.mock.calls.at(-1)?.[1][1]).toBe("%50\\%\\_off%");
    expect(query.mock.calls.at(-1)?.[1][0]).toBeNull();
  });
});
