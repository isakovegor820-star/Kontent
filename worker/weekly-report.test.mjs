import { describe, expect, it, vi } from "vitest";
import { buildWeeklyReport } from "./weekly-report.mjs";

describe("buildWeeklyReport", () => {
  it("передаёт userId во все три запроса и фильтрует tenant-данные", async () => {
    const answers = [
      { rows: [{ posts: 2, views: 150, avg_views: 75 }] },
      { rows: [{ text: "Лучший пост клиента", views: 100 }] },
      { rows: [{ g: 12 }] },
    ];
    const pool = { query: vi.fn(async () => answers.shift()) };

    const text = await buildWeeklyReport(pool, 77);

    expect(pool.query).toHaveBeenCalledTimes(3);
    for (const [sql, params] of pool.query.mock.calls) {
      expect(sql).toContain("user_id = $1");
      expect(params).toEqual([77]);
    }
    expect(text).toContain("2 поста");
    expect(text).toContain("Лучший пост клиента");
    expect(text).toContain("+12");
  });

  it("не принимает пустой или некорректный tenant id", async () => {
    await expect(buildWeeklyReport({ query: vi.fn() }, 0)).rejects.toThrow("bad userId");
  });
});
