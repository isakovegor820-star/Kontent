import { describe, expect, it } from "vitest";
import { completeArticleInternalLinks, validateArticle } from "./generation.mjs";
import { articleHasQualityBlock } from "./quality.mjs";

const site = { confirmedDomain: "example.test" };
const pages = [{ url: "https://example.test/about", title: "О компании" }, { url: "https://example.test/news", title: "Новости" }];

describe("article quality recovery", () => {
  it("requires two different guide pages even when one URL appears twice", () => {
    const result = validateArticle({ title: "Гид", bodyMarkdown: "## Гид\n\n" + "слово ".repeat(905)
      + "[А](https://example.test/about) [Б](https://example.test/about#part)" }, { type: "evergreen_guide", allowedLinks: pages.map((p) => p.url) });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "internal_links_insufficient" }));
  });
  it("fills missing links without inventing URLs, changing facts or bypassing other quality checks", () => {
    const article = { title: "Новость", internalLinks: [{ url: pages[0].url }], bodyMarkdown: "Встреча 20 сентября в 18:00. " + "слово ".repeat(120) };
    const repaired = completeArticleInternalLinks(article, { type: "company_news", site, linkablePages: pages });
    expect(repaired.bodyMarkdown.startsWith(article.bodyMarkdown)).toBe(true);
    expect(repaired.bodyMarkdown).toContain("[О компании](https://example.test/about)");
    expect(repaired.bodyMarkdown).not.toContain("https://example.test/news");
    expect(validateArticle(repaired, { type: "company_news", allowedLinks: pages.map((p) => p.url) }).ok).toBe(true);
    const short = completeArticleInternalLinks({ title: "Новость", bodyMarkdown: "Коротко" }, { type: "company_news", site, linkablePages: pages });
    expect(validateArticle(short, { type: "company_news", allowedLinks: pages.map((p) => p.url) }).ok).toBe(false);
  });
  it("does not add unrelated audit pages just to satisfy the link counter", () => {
    const article = { title: "Новость клуба", bodyMarkdown: "Текст о встрече клуба." };
    expect(completeArticleInternalLinks(article, { type: "company_news", site, linkablePages: pages })).toEqual(article);
  });
  it("does not manufacture links from absent, foreign or credential-bearing pages", () => {
    const article = { title: "Новость", bodyMarkdown: "Текст" };
    expect(completeArticleInternalLinks(article, { type: "company_news", site, linkablePages: [
      { url: "https://foreign.test/a" }, { url: "javascript:alert(1)" }, { url: "https://secret@example.test/a" },
    ] })).toEqual(article);
  });
  it.each([
    { title: "", body_markdown: "" },
    { title: "Текст", body_markdown: "Есть текст", status_reason: "quality" },
    { title: "Текст", body_markdown: "Есть текст", quality: { issues: [{ severity: "error" }] } },
  ])("blocks unusable drafts at the stored quality boundary", (article) => expect(articleHasQualityBlock(article)).toBe(true));
  it("allows a usable legacy draft and a warning-only draft", () => {
    expect(articleHasQualityBlock({ title: "Текст", bodyMarkdown: "Текст", quality: null })).toBe(false);
    expect(articleHasQualityBlock({ title: "Текст", bodyMarkdown: "Текст", quality: { issues: [{ severity: "warning" }] } })).toBe(false);
  });
});
