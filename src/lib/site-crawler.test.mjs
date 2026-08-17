import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SITE_CRAWL_LIMITS,
  buildSiteAnalysisReport,
  crawlSite,
  extractSitePage,
  extractSitemapDocument,
  extractSitemapUrls,
  normalizeSiteLimits,
  normalizeSiteTarget,
  parseRobotsTxt,
  robotsAllows,
  stratifySitemapUrls,
  upgradeLegacySiteLimits,
} from "./site-crawler.mjs";

function response(url, body, status = 200, contentType = "text/html; charset=utf-8") {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: { "content-type": contentType },
    byteLength: Buffer.byteLength(body, "utf8"),
    text: async () => body,
  };
}

describe("site crawler security and extraction", () => {
  it("uses higher but still bounded limits for content-heavy public sites", () => {
    expect(DEFAULT_SITE_CRAWL_LIMITS).toMatchObject({
      maxPages: 20,
      maxPageBytes: 5_000_000,
      maxTotalBytes: 50_000_000,
    });
    expect(normalizeSiteLimits({ maxPageBytes: Number.MAX_SAFE_INTEGER, maxTotalBytes: Number.MAX_SAFE_INTEGER }))
      .toMatchObject({ maxPageBytes: 10_000_000, maxTotalBytes: 100_000_000 });
    expect(upgradeLegacySiteLimits({ maxPages: 20, maxPageBytes: 1_000_000, maxTotalBytes: 6_000_000 }))
      .toMatchObject({ maxPageBytes: 5_000_000, maxTotalBytes: 50_000_000 });
    expect(upgradeLegacySiteLimits({ maxPageBytes: 1_500_000, maxTotalBytes: 12_000_000 }))
      .toMatchObject({ maxPageBytes: 1_500_000, maxTotalBytes: 12_000_000 });
  });

  it("accepts a 1.55 MB homepage within the new default page budget", async () => {
    const heavyHomepage = `<html><body><script>${"x".repeat(1_550_000)}</script><main><h1>Публичный сайт</h1><p>Данные для анализа.</p></main></body></html>`;
    const fetchText = vi.fn(async (url, options) => {
      if (url.endsWith("/robots.txt")) return response(url, "User-agent: *\nAllow: /", 200, "text/plain");
      if (url.endsWith("/sitemap.xml")) return response(url, "", 404, "application/xml");
      const page = response(url, heavyHomepage);
      if (page.byteLength > options.maxBytes) throw Object.assign(new Error("too large"), { code: "too_large" });
      return page;
    });
    const result = await crawlSite({
      targetUrl: "https://example.com/",
      confirmedDomain: "example.com",
      consent: true,
    }, { fetchText });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toMatchObject({ title: "", status: 200 });
    expect(fetchText).toHaveBeenCalledWith("https://example.com/", expect.objectContaining({ maxBytes: 5_000_000 }));
  });

  it("requires explicit consent, exact domain and standard ports", () => {
    expect(() => normalizeSiteTarget("https://example.com", "example.com", false)).toThrowError(
      expect.objectContaining({ code: "consent_required" }),
    );
    expect(() => normalizeSiteTarget("https://evil.example", "example.com", true)).toThrowError(
      expect.objectContaining({ code: "domain_mismatch" }),
    );
    expect(() => normalizeSiteTarget("https://example.com:8443", "example.com", true)).toThrowError(
      expect.objectContaining({ code: "port_forbidden" }),
    );
    expect(normalizeSiteTarget("https://example.com/path#part", "example.com", true).toString())
      .toBe("https://example.com/path");
  });

  it("honours the longest robots rule and allow on an equal match", () => {
    const policy = parseRobotsTxt(`
      User-agent: *
      Disallow: /private/
      Allow: /private/public$
      Sitemap: https://example.com/sitemap.xml
    `);
    expect(robotsAllows(policy, "https://example.com/private/secret")).toBe(false);
    expect(robotsAllows(policy, "https://example.com/private/public")).toBe(true);
    expect(policy.sitemaps).toEqual(["https://example.com/sitemap.xml"]);
    expect(robotsAllows(parseRobotsTxt("User-agent: *\nDisallow: /private"), "https://example.com/%70rivate"))
      .toBe(false);
  });

  it("keeps sitemap URLs on the confirmed host", () => {
    const urls = extractSitemapUrls(`
      <urlset><url><loc>https://example.com/a</loc></url>
      <url><loc>https://outside.example/b</loc></url></urlset>
    `, "https://example.com/");
    expect(urls).toEqual(["https://example.com/a"]);
    expect(extractSitemapDocument("<sitemapindex><sitemap><loc>/child.xml</loc></sitemap></sitemapindex>", "https://example.com/"))
      .toEqual({ kind: "index", urls: ["https://example.com/child.xml"] });
  });

  it("stratifies sitemap URLs so news cannot crowd out team, offers and partners", () => {
    const urls = [
      ...Array.from({ length: 20 }, (_, index) => `https://example.com/news/${index}`),
      "https://example.com/team",
      "https://example.com/services/audit",
      "https://example.com/partners",
      "https://example.com/about",
      "https://example.com/contact",
    ];
    const selected = stratifySitemapUrls(urls, 8);
    expect(selected).toEqual(expect.arrayContaining([
      "https://example.com/team",
      "https://example.com/services/audit",
      "https://example.com/partners",
      "https://example.com/about",
      "https://example.com/contact",
    ]));
    expect(selected.filter((url) => url.includes("/news/")).length).toBeLessThanOrEqual(3);
  });

  it("extracts observable page evidence without hidden comments", () => {
    const page = extractSitePage(`<!doctype html><html lang="ru"><head>
      <title>Юридическая практика</title><meta name="description" content="Разбор договоров">
      <meta name="viewport" content="width=device-width"><link rel="canonical" href="/practice">
      <script type="application/ld+json">{"@type":"Article"}</script></head><body>
      <main><h1>Разбор договора</h1><h2>Что проверить</h2><p>Публичное объяснение для бизнеса.</p>
      <a href="/contact">Получить консультацию</a><form action="/lead" method="post"><input name="email"></form>
      <div class="comment">Публичный отзыв клиента</div>
      <div class="comment" hidden>Скрытый отзыв</div></main></body></html>`, "https://example.com/practice");
    expect(page.title).toBe("Юридическая практика");
    expect(page.schemaTypes).toContain("Article");
    expect(page.ctas).toContain("Получить консультацию");
    expect(page.forms[0]).toMatchObject({ method: "POST", fields: ["email"] });
    expect(page.publicComments).toEqual(["Публичный отзыв клиента"]);
    expect(page.technical).toMatchObject({
      canonical: "https://example.com/practice",
      h1Count: 1,
      headingOrderValid: true,
      imageCount: 0,
      missingImageAlt: 0,
    });
  });

  it("removes database-incompatible control characters from every extracted field", () => {
    const page = extractSitePage(`
      <html><head>
        <title>Компания&#0; Аврора</title>
        <script type="application/ld+json">{
          "@type":"Organization",
          "name":"Аврора",
          "dateModified":"2026-08-05\\u0000",
          "sameAs":["https://example.com/social\\u0000"]
        }</script>
      </head><body><main><h1>Анализ&#x0; сайта</h1></main></body></html>
    `, "https://example.com/");

    expect(JSON.stringify(page)).not.toContain("\\u0000");
    expect(page.title).toBe("Компания Аврора");
    expect(page.headings[0].text).toBe("Анализ сайта");
  });

  it("removes credentials and sensitive query data before URLs are stored", () => {
    const page = extractSitePage(`
      <html><body><main><h1>Links</h1>
      <a href="https://user:pass@example.com/private">secret</a>
      <a href="/next?access_token=secret&utm_source=mail&keep=1">next</a>
      <form action="/lead?session=secret&campaign=public"><input name="email"></form>
      </main></body></html>
    `, "https://example.com/?token=secret&keep=start");
    expect(page.url).toBe("https://example.com/?keep=start");
    expect(page.links).toEqual([expect.objectContaining({ url: "https://example.com/next?keep=1" })]);
    expect(page.forms[0].action).toBe("https://example.com/lead?campaign=public");
    expect(normalizeSiteTarget(
      "https://example.com/?access_token=secret&keep=1",
      "example.com",
      true,
    ).toString()).toBe("https://example.com/?keep=1");
  });

  it("crawls in deterministic batches, sends redirect boundary, reports progress and evidence", async () => {
    const calls = [];
    const fetchText = vi.fn(async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/robots.txt")) return response(url, "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap.xml", 200, "text/plain");
      if (url.endsWith("/sitemap.xml")) return response(url, "<urlset><url><loc>https://example.com/about</loc></url></urlset>", 200, "application/xml");
      if (url.endsWith("/about")) return response(url, "<html><head><title>О нас</title></head><body><main><h1>О нас</h1><p>Команда помогает бизнесу разбирать договоры и риски понятным языком.</p></main></body></html>");
      return response(url, "<html><head><title>Главная</title></head><body><main><h1>Практика</h1><a href='/about'>О нас</a></main></body></html>");
    });
    const progress = [];
    const result = await crawlSite({
      targetUrl: "https://example.com/",
      confirmedDomain: "example.com",
      consent: true,
      limits: { maxPages: 3 },
    }, { fetchText, onProgress: (event) => progress.push(event) });

    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/about",
    ]);
    expect(progress.at(-1)).toMatchObject({ stage: "ready", progress: 100 });
    expect(calls.every((call) => typeof call.options.validateRedirect === "function")).toBe(true);
    expect(result.report.inventory).toHaveLength(2);
    expect(result.report.marketingPlan.measurement).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceNeeded: expect.stringContaining("Google Search Console") }),
    ]));
    expect(result.report.optimization.seo.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "robots", status: "passed" }),
      expect.objectContaining({ id: "sitemap", status: "passed" }),
      expect.objectContaining({ id: "speed", status: "not_checked" }),
    ]));
    const conclusions = [
      ...result.report.seoAudit,
      ...result.report.geoAudit,
      ...result.report.themes,
    ];
    expect(conclusions.every((item) => Array.isArray(item.evidence) && item.evidence.length > 0)).toBe(true);
  });

  it("loads independent pages concurrently while preserving queue order", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const fetchText = vi.fn(async (url) => {
      if (url.endsWith("/robots.txt")) return response(url, "User-agent: *\nAllow: /", 200, "text/plain");
      if (url.endsWith("/sitemap.xml")) {
        return response(url, "<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url><url><loc>https://example.com/c</loc></url></urlset>", 200, "application/xml");
      }
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, url.endsWith("/a") ? 15 : 5));
      inFlight -= 1;
      return response(url, `<html><body><main><h1>${new URL(url).pathname}</h1></main></body></html>`);
    });

    const result = await crawlSite({
      targetUrl: "https://example.com/",
      confirmedDomain: "example.com",
      consent: true,
      limits: { maxPages: 4 },
    }, { fetchText, concurrency: 4 });

    expect(peakInFlight).toBeGreaterThan(1);
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });

  it("fails closed when robots is unavailable or denies the page", async () => {
    await expect(crawlSite({
      targetUrl: "https://example.com/",
      confirmedDomain: "example.com",
      consent: true,
    }, {
      fetchText: async (url) => response(url, "", 503, "text/plain"),
    })).rejects.toMatchObject({ code: "robots_unavailable" });

    await expect(crawlSite({
      targetUrl: "https://example.com/private",
      confirmedDomain: "example.com",
      consent: true,
    }, {
      fetchText: async (url) => response(url, "User-agent: *\nDisallow: /private", 200, "text/plain"),
    })).rejects.toMatchObject({ code: "robots_denied" });

    await expect(crawlSite({
      targetUrl: "https://example.com/",
      confirmedDomain: "example.com",
      consent: true,
    }, {
      fetchText: async (url) => response(url, "rate limited", 429, "text/plain"),
    })).rejects.toMatchObject({ code: "robots_unavailable" });
  });

  it("checks robots policy on every redirect before requesting its destination", async () => {
    const fetchText = vi.fn(async (url, options) => {
      if (url.endsWith("/robots.txt")) {
        return response(url, "User-agent: *\nDisallow: /private", 200, "text/plain");
      }
      if (url.endsWith("/sitemap.xml")) return response(url, "", 404, "application/xml");
      const next = new URL("/private", url);
      options.validateRedirect(next, new URL(url));
      throw new Error("redirect validator must stop this request");
    });
    await expect(crawlSite({
      targetUrl: "https://example.com/start",
      confirmedDomain: "example.com",
      consent: true,
    }, { fetchText })).rejects.toMatchObject({ code: "robots_denied" });
  });

  it("bounds sitemap indexes and includes robots/sitemaps in the total byte budget", async () => {
    const oversizedRobots = `User-agent: *\nSitemap: https://example.com/index.xml\n#${"r".repeat(39_000)}`;
    const oversizedSitemap = `<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap>${"s".repeat(30_000)}</sitemapindex>`;
    const fetchText = vi.fn(async (url) => {
      if (url.endsWith("/robots.txt")) return response(url, oversizedRobots, 200, "text/plain");
      return response(url, oversizedSitemap, 200, "application/xml");
    });
    await expect(crawlSite({
      targetUrl: "https://example.com/",
      confirmedDomain: "example.com",
      consent: true,
      limits: { maxTotalBytes: 64_000, maxSitemaps: 2 },
    }, { fetchText })).rejects.toMatchObject({ code: "crawl_too_large" });
    expect(fetchText).toHaveBeenCalledTimes(2);
  });

  it("counts partial bytes from reset responses against the same total budget", async () => {
    const fetchText = vi.fn(async (url) => {
      if (url.endsWith("/robots.txt")) return response(url, "User-agent: *\nAllow: /", 200, "text/plain");
      if (url.endsWith("/sitemap.xml")) {
        return response(url, "<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>", 200, "application/xml");
      }
      if (url.endsWith("/a") || url.endsWith("/b")) {
        throw Object.assign(new Error("reset after partial body"), { code: "ECONNRESET", byteLength: 32_000 });
      }
      return response(url, "<html><body><main><h1>Home</h1></main></body></html>");
    });
    await expect(crawlSite({
      targetUrl: "https://example.com/",
      confirmedDomain: "example.com",
      consent: true,
      limits: { maxPages: 5, maxTotalBytes: 64_000 },
    }, { fetchText })).rejects.toMatchObject({ code: "crawl_too_large" });
  });

  it("recurses through a bounded sitemapindex and deduplicates redirect aliases", async () => {
    const sitemapCalls = [];
    const fetchText = vi.fn(async (url) => {
      if (url.endsWith("/robots.txt")) {
        return response(url, "User-agent: *\nAllow: /\nSitemap: https://example.com/index.xml", 200, "text/plain");
      }
      if (url.endsWith("/index.xml")) {
        sitemapCalls.push(url);
        return response(url, "<sitemapindex><sitemap><loc>https://example.com/child.xml</loc></sitemap></sitemapindex>", 200, "application/xml");
      }
      if (url.endsWith("/sitemap.xml")) {
        sitemapCalls.push(url);
        return response(url, "", 404, "application/xml");
      }
      if (url.endsWith("/child.xml")) {
        sitemapCalls.push(url);
        return response(url, "<urlset><url><loc>https://example.com/a</loc></url><url><loc>https://example.com/b</loc></url></urlset>", 200, "application/xml");
      }
      if (url.endsWith("/a") || url.endsWith("/b")) {
        return response("https://example.com/final", "<html><body><main><h1>Final</h1></main></body></html>");
      }
      return response(url, "<html><body><main><h1>Home</h1></main></body></html>");
    });
    const result = await crawlSite({
      targetUrl: "https://example.com/",
      confirmedDomain: "example.com",
      consent: true,
      limits: { maxPages: 5, maxSitemaps: 3 },
    }, { fetchText });
    expect(sitemapCalls).toHaveLength(3);
    expect(result.pages.map((page) => page.url)).toEqual([
      "https://example.com/",
      "https://example.com/final",
    ]);
  });

  it("attaches theme evidence when a theme appears only in a heading", () => {
    const page = extractSitePage("<html><body><main><h1>Криптография</h1><p>Коротко.</p></main></body></html>", "https://example.com/");
    const report = buildSiteAnalysisReport("https://example.com/", [page]);
    expect(report.themes.find((theme) => theme.theme === "криптография")?.evidence)
      .toEqual([{ url: "https://example.com/", label: "Упоминание «криптография»" }]);
  });

  it("builds separate evidence-based SEO and GEO scores, checks and prioritized tasks", () => {
    const longCopy = Array.from({ length: 130 }, (_, index) => `факт${index}`).join(" ");
    const page = extractSitePage(`<!doctype html><html lang="ru"><head>
      <title>Компания Аврора — юридический консалтинг</title>
      <meta name="description" content="Юридический консалтинг для компаний в Москве: договоры, риски и проверяемые рекомендации экспертов.">
      <meta name="viewport" content="width=device-width"><link rel="canonical" href="/">
      <script type="application/ld+json">{
        "@context":"https://schema.org","@graph":[
          {"@type":"Organization","name":"Аврора"},
          {"@type":"Service","name":"Юридический аудит"},
          {"@type":"Person","name":"Анна Иванова","jobTitle":"Эксперт"},
          {"@type":"FAQPage","name":"Ответы на вопросы"}
        ]
      }</script></head><body><main>
      <h1>Юридический консалтинг в Москве</h1><h2>Почему выбирают Аврору?</h2>
      <p>15 лет опыта и 98% проверенных договоров. ${longCopy}</p>
      <h2>Как проходит аудит?</h2><p>Эксперт отвечает прямо и ссылается на первоисточник.</p>
      <a href="https://publication.pravo.gov.ru/">Официальный источник</a>
      <img src="team.jpg" alt="Команда юридических экспертов">
      </main></body></html>`, "https://example.com/");
    const report = buildSiteAnalysisReport(
      "https://example.com/",
      [page],
      DEFAULT_SITE_CRAWL_LIMITS,
      { robotsStatus: 200, sitemapAvailable: true, sitemapUrlCount: 1 },
    );

    expect(report.optimization).toMatchObject({
      version: "aurora-seo-geo-mvp-v1",
      geoDefinition: { term: "Generative Engine Optimization" },
      seo: { score: expect.any(Number) },
      geo: { score: expect.any(Number) },
    });
    expect(report.optimization.seo.checks).toHaveLength(15);
    expect(report.optimization.geo.checks).toHaveLength(9);
    expect(report.optimization.seo.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "images", status: "passed" }),
      expect.objectContaining({ id: "speed", status: "not_checked" }),
    ]));
    expect(report.optimization.geo.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "experts", status: "passed" }),
      expect.objectContaining({ id: "facts", status: "passed" }),
      expect.objectContaining({ id: "faq", status: "passed" }),
      expect.objectContaining({ id: "geography", status: "passed" }),
    ]));
    expect(report.optimization.seo.score).toBeGreaterThanOrEqual(85);
    expect(report.optimization.geo.score).toBeGreaterThanOrEqual(85);
  });

  it("turns observable SEO failures into critical checks without inventing speed data", () => {
    const page = extractSitePage(`<!doctype html><html><head>
      <meta name="robots" content="noindex">
    </head><body><main><h1>Коротко</h1><h3>Детали</h3><img src="proof.jpg"></main></body></html>`, "http://example.com/");
    const broken = extractSitePage("", "http://example.com/missing", 404);
    const report = buildSiteAnalysisReport(
      "http://example.com/",
      [page, broken],
      DEFAULT_SITE_CRAWL_LIMITS,
      { robotsStatus: 404, sitemapAvailable: false, sitemapUrlCount: 0 },
    );

    expect(report.optimization.seo.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "title", status: "critical" }),
      expect.objectContaining({ id: "indexing", status: "critical" }),
      expect.objectContaining({ id: "links", status: "critical" }),
      expect.objectContaining({ id: "images", status: "warning" }),
      expect.objectContaining({ id: "robots", status: "warning" }),
      expect.objectContaining({ id: "sitemap", status: "warning" }),
      expect.objectContaining({ id: "speed", status: "not_checked", confidence: "requires_integration" }),
    ]));
    expect(report.optimization.seo.summary.critical).toBeGreaterThanOrEqual(3);
    expect(report.optimization.seo.tasks[0]).toMatchObject({ priority: "P0" });
    expect(report.limitations.join(" ")).toMatch(/Core Web Vitals/i);
  });

  it("never presents public crawl as traffic or hidden-comment data", () => {
    const page = extractSitePage("<html><head><title>A</title></head><body><main><h1>A</h1></main></body></html>", "https://example.com/");
    const report = buildSiteAnalysisReport("https://example.com/", [page]);
    expect(report.limitations.join(" ")).toMatch(/не показывает посещаемость/i);
    expect(report.limitations.join(" ")).toMatch(/публично присутствуют/i);
    expect(report.marketingPlan.measurement.every((row) => row.confidence === "requires_integration")).toBe(true);
  });
});
