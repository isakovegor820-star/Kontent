import { describe, expect, it, vi } from "vitest";

import { refreshSiteCompetitors } from "./site-competitors-refresh.mjs";

function poolWith(rows) {
  const calls = [];
  const query = vi.fn(async (sql, params) => {
    calls.push({ sql: String(sql), params });
    if (String(sql).includes("from site_competitors")) return { rows };
    return { rows: [] };
  });
  return { query, calls };
}

const competitor = { id: 3, domain: "rival.ru", canonical_url: "https://rival.ru/" };

function crawlOk() {
  return {
    pages: [{ url: "https://rival.ru/", status: 200, schemaTypes: ["Organization"], technical: { wordCount: 300, clientRendered: false } }],
    report: { themes: [{ theme: "банкротство", occurrences: 3 }] },
  };
}

describe("refreshSiteCompetitors", () => {
  it("сохраняет снимок конкурента тем же обходчиком", async () => {
    const pool = poolWith([competitor]);
    const crawl = vi.fn(async () => crawlOk());

    const result = await refreshSiteCompetitors(pool, { siteId: 5, crawl });

    expect(result).toEqual({ updated: 1, failed: 0 });
    expect(crawl).toHaveBeenCalledWith(expect.objectContaining({
      targetUrl: "https://rival.ru/",
      confirmedDomain: "rival.ru",
      consent: true,
    }));
    const saved = pool.calls.find((call) => call.sql.includes("set status = 'ready'"));
    expect(saved).toBeTruthy();
    expect(JSON.parse(saved.params[2])).toMatchObject({ domain: "rival.ru", pages: 1, avgWords: 300, hasOrganization: true });
  });

  it("недоступный конкурент получает статус ошибки, остальные обрабатываются", async () => {
    const pool = poolWith([competitor, { id: 4, domain: "broken.ru", canonical_url: "https://broken.ru/" }]);
    const crawl = vi.fn(async ({ confirmedDomain }) => {
      if (confirmedDomain === "broken.ru") throw Object.assign(new Error("нет ответа"), { code: "timeout" });
      return crawlOk();
    });

    const result = await refreshSiteCompetitors(pool, { siteId: 5, crawl });

    expect(result).toEqual({ updated: 1, failed: 1 });
    const failed = pool.calls.find((call) => call.sql.includes("set status = 'error'"));
    expect(failed.params[2]).toBe("timeout");
  });

  it("ничего не делает, если конкурентов нет", async () => {
    const pool = poolWith([]);
    const crawl = vi.fn();
    const result = await refreshSiteCompetitors(pool, { siteId: 5, crawl });
    expect(result).toEqual({ updated: 0, failed: 0, skipped: "no_competitors" });
    expect(crawl).not.toHaveBeenCalled();
  });

  it("не работает без привязки к сайту", async () => {
    const pool = poolWith([competitor]);
    const result = await refreshSiteCompetitors(pool, { siteId: null });
    expect(result).toEqual({ updated: 0, failed: 0, skipped: "no_site" });
    expect(pool.calls).toHaveLength(0);
  });
});
