// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ site: vi.fn(), article: vi.fn(), list: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/site-hosted/service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/site-hosted/service")>(),
  loadHostedSite: mocks.site, loadHostedArticle: mocks.article, listHostedArticles: mocks.list,
}));
import IndexPage from "./[slug]/page";
import ArticlePage from "./[slug]/[article]/page";

const hostile = '</script><img src=x onerror="alert(1)"><script>';
describe("hosted structured data HTML boundary", () => {
  beforeEach(() => {
    mocks.site.mockResolvedValue({ id: 1, slug: "brand", brandName: hostile, origin: "https://brand.example.test", canonicalUrl: "https://example.test", confirmedDomain: "example.test" });
    mocks.article.mockResolvedValue({ id: 2, slug: "article", title: hostile, metaDescription: hostile, bodyHtml: "<p>Safe article</p>", structuredData: { nested: { value: hostile } }, url: "https://brand.example.test/article" });
    mocks.list.mockResolvedValue([]);
  });

  it.each(["index", "article"])("keeps untrusted strings inside JSON on the %s page", async (kind) => {
    const element = kind === "index"
      ? await IndexPage({ params: Promise.resolve({ slug: "brand" }) })
      : await ArticlePage({ params: Promise.resolve({ slug: "brand", article: "article" }) });
    const document = new DOMParser().parseFromString(renderToStaticMarkup(element), "text/html");
    expect(document.querySelectorAll("script")).toHaveLength(1);
    expect(document.querySelector("img")).toBeNull();
    const data = JSON.parse(document.querySelector("script")!.textContent!);
    expect(data.publisher.name).toBe(hostile);
    if (kind === "article") expect(data.nested.value).toBe(hostile);
  });
});
