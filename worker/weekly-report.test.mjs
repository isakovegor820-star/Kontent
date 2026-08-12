import { describe, expect, it, vi } from "vitest";
import { buildWeeklyReport } from "./weekly-report.mjs";

describe("buildWeeklyReport", () => {
  it("передаёт projectId во все три запроса, а userId оставляет получателем", async () => {
    const answers = [
      { rows: [{ posts: 2, views: 150, avg_views: 75 }] },
      { rows: [{ text: "Лучший пост клиента", views: 100 }] },
      { rows: [{ g: 12 }] },
    ];
    const pool = { query: vi.fn(async () => answers.shift()) };

    const text = await buildWeeklyReport(pool, { userId: 77, projectId: 101 });

    expect(pool.query).toHaveBeenCalledTimes(3);
    for (const [sql, params] of pool.query.mock.calls) {
      expect(sql).toContain("project_id = $1");
      expect(sql).not.toContain("p.user_id = $1");
      expect(params).toEqual([101]);
    }
    expect(text).toContain("2 поста");
    expect(text).toContain("Лучший пост клиента");
    expect(text).toContain("+12");
  });

  it("изолирует одинакового получателя между проектами A и B", async () => {
    const pool = {
      query: vi.fn(async (_sql, [projectId]) => {
        if (projectId === 101) {
          const call = pool.query.mock.calls.filter((entry) => entry[1]?.[0] === 101).length;
          if (call === 1) return { rows: [{ posts: 1, views: 80, avg_views: 80 }] };
          if (call === 2) return { rows: [{ text: "Пост проекта A", views: 80 }] };
          return { rows: [{ g: 3 }] };
        }
        const call = pool.query.mock.calls.filter((entry) => entry[1]?.[0] === 202).length;
        if (call === 1) return { rows: [{ posts: 1, views: 25, avg_views: 25 }] };
        if (call === 2) return { rows: [{ text: "Пост проекта B", views: 25 }] };
        return { rows: [{ g: -1 }] };
      }),
    };

    const projectA = await buildWeeklyReport(pool, { userId: 77, projectId: 101 });
    const projectB = await buildWeeklyReport(pool, { userId: 77, projectId: 202 });

    expect(projectA).toContain("Пост проекта A");
    expect(projectA).not.toContain("Пост проекта B");
    expect(projectB).toContain("Пост проекта B");
    expect(projectB).not.toContain("Пост проекта A");
    expect(pool.query.mock.calls.map(([, params]) => params)).toEqual([
      [101], [101], [101], [202], [202], [202],
    ]);
  });

  it("не принимает пустые actor/project идентификаторы", async () => {
    await expect(
      buildWeeklyReport({ query: vi.fn() }, { userId: 0, projectId: 101 }),
    ).rejects.toThrow("bad userId");
    await expect(
      buildWeeklyReport({ query: vi.fn() }, { userId: 77, projectId: 0 }),
    ).rejects.toThrow("bad projectId");
  });
});
