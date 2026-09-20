import { describe, expect, it, vi } from "vitest";
import { approveSiteArticle } from "./articles-service";

describe("article approval admission", () => {
  it.each([
    { title: "", body_markdown: "", status_reason: null },
    { title: "Статья", body_markdown: "Текст", status_reason: "quality" },
    { title: "Статья", body_markdown: "Текст", quality: { issues: [{ severity: "error", code: "too_short" }] } },
  ])("rejects unusable legacy and edited articles before any approval write", async (article) => {
    const query = vi.fn();
    await expect(approveSiteArticle({ query } as never, {
      site: { id: 5, publishing_mode: "auto", verification_state: "verified" },
      article: { id: 4, status: "failed", version: 1, ...article }, userId: 9,
    } as never)).rejects.toMatchObject({ code: "article_quality_failed", status: 422 });
    expect(query).not.toHaveBeenCalled();
  });
  it("does not count a second approval of the same version toward automatic publishing", async () => {
    const article = { id: 4, site_id: 5, title: "Статья", body_markdown: "Текст", status: "approved", version: 2, approved_version: 2, approved_at: new Date(), quality: { issues: [] } };
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("update site_articles") ? [article] : [{ n: 0 }] }));
    await approveSiteArticle({ query } as never, { site: { id: 5, verification_state: "unverified" }, article, userId: 9 } as never);
    expect(query.mock.calls.some(([sql]) => sql.includes("approved_streak"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into site_article_revisions"))).toBe(false);
  });
});
