import type { Pool, PoolClient } from "pg";

import { hostedArticleUrl, hostedSectionOrigin } from "../site-destinations/index.mjs";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type HostedSite = {
  id: number;
  slug: string;
  confirmedDomain: string;
  canonicalUrl: string;
  brandName: string;
  origin: string;
};

export type HostedArticle = {
  id: number;
  slug: string;
  title: string;
  metaDescription: string | null;
  bodyHtml: string;
  structuredData: Record<string, unknown> | null;
  articleType: string;
  publishedAt: string | null;
  updatedAt: string | null;
  url: string;
};

/**
 * Раздел отдаётся только для подтверждённого активного сайта с включённым назначением
 * site_hosted. Неизвестный slug → null, без раскрытия существования сайта.
 */
export async function loadHostedSite(db: Queryable, slug: string, env: Record<string, string | undefined> = process.env): Promise<HostedSite | null> {
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u.test(slug)) return null;
  const result = await db.query<{
    id: string | number;
    hosted_slug: string;
    confirmed_domain: string;
    canonical_url: string;
    brand_name: string | null;
  }>(
    `select s.id, s.hosted_slug, s.confirmed_domain, s.canonical_url, s.brand_name
       from sites s
       join site_destinations d on d.site_id = s.id and d.kind = 'site_hosted' and d.status = 'active'
      where s.hosted_slug = $1 and s.status = 'active' and s.verification_state = 'verified'`,
    [slug],
  );
  const row = result.rows[0];
  if (!row) return null;
  const origin = hostedSectionOrigin(row.hosted_slug, env);
  if (!origin) return null;
  return {
    id: Number(row.id),
    slug: row.hosted_slug,
    confirmedDomain: row.confirmed_domain,
    canonicalUrl: row.canonical_url,
    brandName: row.brand_name || row.confirmed_domain,
    origin,
  };
}

type ArticleRow = {
  id: string | number;
  slug: string;
  title: string;
  meta_description: string | null;
  body_html: string | null;
  structured_data: Record<string, unknown> | null;
  article_type: string;
  published_at: Date | string | null;
  updated_at: Date | string | null;
};

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toArticle(row: ArticleRow, site: HostedSite, env: Record<string, string | undefined>): HostedArticle {
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    metaDescription: row.meta_description,
    bodyHtml: row.body_html || "",
    structuredData: row.structured_data,
    articleType: row.article_type,
    publishedAt: iso(row.published_at),
    updatedAt: iso(row.updated_at),
    url: hostedArticleUrl(site.slug, row.slug, env) || `${site.origin}/${row.slug}`,
  };
}

const ARTICLE_FIELDS = `id, slug, title, meta_description, body_html, structured_data, article_type, published_at, updated_at`;

export async function listHostedArticles(db: Queryable, site: HostedSite, limit = 100, env: Record<string, string | undefined> = process.env): Promise<HostedArticle[]> {
  const result = await db.query<ArticleRow>(
    `select ${ARTICLE_FIELDS} from site_articles
      where site_id = $1 and status = 'published'
      order by published_at desc nulls last, id desc
      limit $2`,
    [site.id, Math.min(500, Math.max(1, limit))],
  );
  return result.rows.map((row) => toArticle(row, site, env));
}

export async function loadHostedArticle(db: Queryable, site: HostedSite, articleSlug: string, env: Record<string, string | undefined> = process.env): Promise<HostedArticle | null> {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/u.test(articleSlug)) return null;
  const result = await db.query<ArticleRow>(
    `select ${ARTICLE_FIELDS} from site_articles where site_id = $1 and slug = $2 and status = 'published'`,
    [site.id, articleSlug],
  );
  return result.rows[0] ? toArticle(result.rows[0], site, env) : null;
}

function xml(value: string) {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

export function hostedSitemapXml(site: HostedSite, articles: HostedArticle[]): string {
  const urls = [
    `<url><loc>${xml(site.origin)}/</loc><changefreq>weekly</changefreq></url>`,
    ...articles.map((article) => `<url><loc>${xml(article.url)}</loc>${article.updatedAt ? `<lastmod>${article.updatedAt.slice(0, 10)}</lastmod>` : ""}</url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function hostedRobotsTxt(site: HostedSite): string {
  return `User-agent: *\nAllow: /\nSitemap: ${site.origin}/sitemap.xml\n`;
}

export function articleJsonLd(site: HostedSite, article: HostedArticle): Record<string, unknown> {
  const base = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: article.title,
    description: article.metaDescription || undefined,
    datePublished: article.publishedAt || undefined,
    dateModified: article.updatedAt || undefined,
    mainEntityOfPage: article.url,
    publisher: { "@type": "Organization", name: site.brandName, url: site.canonicalUrl },
    isPartOf: { "@type": "WebSite", name: site.brandName, url: site.origin },
  };
  if (article.structuredData && typeof article.structuredData === "object") {
    return { ...base, ...article.structuredData, "@context": "https://schema.org" };
  }
  return base;
}

export function sectionJsonLd(site: HostedSite): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: `${site.brandName} — материалы`,
    url: site.origin,
    publisher: { "@type": "Organization", name: site.brandName, url: site.canonicalUrl },
  };
}
