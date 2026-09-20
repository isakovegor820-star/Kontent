// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import HostedIndexPage from "@/app/hosted/[slug]/page";
import HostedArticlePage from "@/app/hosted/[slug]/[article]/page";

const fixtures = vi.hoisted(() => {
  const injection = '</script><script data-injected="yes">globalThis.compromised=true</script>';
  return {
    site: { id: 1, slug: "fixture", brandName: injection, confirmedDomain: "fixture.example", canonicalUrl: "https://fixture.example/", origin: "https://fixture.hosted.example" },
    article: { id: 1, slug: "article", title: injection, metaDescription: injection, structuredData: { description: injection }, bodyHtml: "<p>Safe rendered markdown</p>", articleType: "company_news", publishedAt: "2026-09-05T00:00:00Z", updatedAt: null, url: "https://fixture.hosted.example/article" },
  };
});
vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/site-hosted/service", async (load) => ({
  ...await load<typeof import("./service")>(),
  loadHostedSite: vi.fn(async () => fixtures.site),
  listHostedArticles: vi.fn(async () => [fixtures.article]),
  loadHostedArticle: vi.fn(async () => fixtures.article),
}));
vi.stubGlobal("React", React);
afterEach(() => { document.body.innerHTML = ""; });

describe("hosted JSON-LD HTML boundary", () => {
  it.each(["index", "article"])("keeps stored script terminators as data on the %s page", async (page) => {
    const component = page === "index"
      ? await HostedIndexPage({ params: Promise.resolve({ slug: "fixture" }) })
      : await HostedArticlePage({ params: Promise.resolve({ slug: "fixture", article: "article" }) });
    document.body.innerHTML = renderToStaticMarkup(component);
    expect(document.querySelector("script[data-injected]")).toBeNull();
    const json = document.querySelector('script[type="application/ld+json"]');
    expect(json).not.toBeNull();
    const parsed = JSON.parse(json!.textContent!);
    expect(parsed.publisher.name).toBe(fixtures.site.brandName);
    if (page === "article") expect(parsed.description).toBe(fixtures.article.metaDescription);
    expect(document.querySelectorAll("script")).toHaveLength(1);
  });
});
