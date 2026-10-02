import { afterEach, describe, expect, it, vi } from "vitest";

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import {
  organizationJsonLd,
  softwareApplicationJsonLd,
  webSiteJsonLd,
} from "./product-json-ld";
import { jsonLdHtml } from "./json-ld-html";
import { GUIDES } from "@/lib/guides/articles";
import { DISALLOWED_PATHS, PUBLIC_ROUTES, publicOrigin } from "./public-routes";

const ORIGIN = "https://app.example.com";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("public origin", () => {
  it("reads APP_URL and refuses anything that is not http(s)", () => {
    vi.stubEnv("APP_URL", ORIGIN);
    expect(publicOrigin()).toBe(ORIGIN);

    vi.stubEnv("APP_URL", "");
    expect(publicOrigin()).toBeNull();

    vi.stubEnv("APP_URL", "not a url");
    expect(publicOrigin()).toBeNull();

    vi.stubEnv("APP_URL", "javascript:alert(1)");
    expect(publicOrigin()).toBeNull();
  });
});

describe("robots.txt", () => {
  it("points at the sitemap on the canonical origin and closes only service paths", () => {
    vi.stubEnv("APP_URL", ORIGIN);
    const file = robots();
    expect(file.sitemap).toBe(`${ORIGIN}/sitemap.xml`);

    const rules = Array.isArray(file.rules) ? file.rules : [file.rules];
    const wildcard = rules.find((rule) => rule.userAgent === "*");
    expect(wildcard?.disallow).toEqual([...DISALLOWED_PATHS]);
    expect(wildcard?.allow).toBe("/");
  });

  it("never blocks a search or AI crawler, and keeps noindex pages crawlable", () => {
    vi.stubEnv("APP_URL", ORIGIN);
    const rules = robots().rules;
    const list = Array.isArray(rules) ? rules : [rules];
    const wildcard = list.find((rule) => rule.userAgent === "*");
    const disallowed = String(wildcard?.disallow ?? "");

    // Страницы с robots:{index:false} обязаны оставаться доступными для обхода:
    // Disallow не даёт краулеру увидеть сам noindex.
    for (const path of ["/login", "/register", "/forgot-password", "/reset-password", "/confirm-email"]) {
      expect(disallowed).not.toContain(path);
    }

    const named = list
      .filter((rule) => rule.userAgent !== "*")
      .flatMap((rule) => (Array.isArray(rule.userAgent) ? rule.userAgent : [rule.userAgent]));
    for (const agent of [
      "Googlebot",
      "Bingbot",
      "YandexBot",
      "OAI-SearchBot",
      "PerplexityBot",
      "ClaudeBot",
      "Claude-SearchBot",
    ]) {
      expect(named).toContain(agent);
    }
  });

  it("omits the sitemap line when APP_URL is missing instead of emitting localhost", () => {
    vi.stubEnv("APP_URL", "");
    expect(robots().sitemap).toBeUndefined();
  });
});

describe("sitemap.xml", () => {
  it("lists the public routes and every guide on the canonical origin", () => {
    vi.stubEnv("APP_URL", ORIGIN);
    const urls = sitemap().map((entry) => entry.url);

    for (const route of PUBLIC_ROUTES) {
      expect(urls).toContain(new URL(route.path, ORIGIN).toString());
    }
    // Разбор попадает в карту вместе со страницей, а не отдельным коммитом.
    for (const guide of GUIDES) {
      expect(urls).toContain(`${ORIGIN}/guide/${guide.slug}`);
    }
    expect(urls).toHaveLength(PUBLIC_ROUTES.length + GUIDES.length);
    // Ни один адрес не должен вести на чужой хост: карта обязана быть однохостовой.
    for (const url of urls) {
      expect(new URL(url).origin).toBe(ORIGIN);
    }
  });

  it("returns an empty sitemap rather than foreign URLs when APP_URL is missing", () => {
    vi.stubEnv("APP_URL", "");
    expect(sitemap()).toEqual([]);
  });
});

describe("entity JSON-LD", () => {
  it("links WebSite and SoftwareApplication to one Organization @id", () => {
    const organization = organizationJsonLd(ORIGIN);
    const website = webSiteJsonLd(ORIGIN);
    const product = softwareApplicationJsonLd(ORIGIN);

    expect(organization["@id"]).toBe(`${ORIGIN}/#organization`);
    expect(website.publisher).toEqual({ "@id": `${ORIGIN}/#organization` });
    expect(product.publisher).toEqual({ "@id": `${ORIGIN}/#organization` });
    expect(product.featureList).toBeInstanceOf(Array);
    expect((product.featureList as string[]).length).toBeGreaterThan(0);
  });

  it("does not ship unverified facts: no rating, no price, no address, no sameAs", () => {
    const serialized = JSON.stringify([
      organizationJsonLd(ORIGIN),
      webSiteJsonLd(ORIGIN),
      softwareApplicationJsonLd(ORIGIN),
    ]);
    for (const field of ["aggregateRating", "review", "offers", "price", "address", "legalName", "sameAs", "vatID"]) {
      expect(serialized).not.toContain(`"${field}"`);
    }
  });

  it("escapes «<» so a brand value cannot break out of the script block", () => {
    const html = jsonLdHtml({ name: "</script><script>alert(1)</script>" });
    expect(html).not.toContain("</script>");
    expect(html).toContain("\\u003c");
    expect(JSON.parse(html).name).toBe("</script><script>alert(1)</script>");
  });
});
