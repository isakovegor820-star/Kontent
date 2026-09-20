import type { Pool, PoolClient } from "pg";

import { hostedArticleUrl, hostedSectionOrigin } from "../site-destinations/index.mjs";
import { articleContentHash } from "../site-articles/service.mjs";
import { renderMarkdown } from "../site-articles/markdown.mjs";

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
  article_type: string;
  published_at: Date | string | null;
  updated_at: Date | string | null;
  revision_snapshot: Record<string, unknown>;
  revision_hash: string;
};

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toArticle(row: ArticleRow, site: HostedSite, env: Record<string, string | undefined>): HostedArticle | null {
  const snapshot = row.revision_snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
    || typeof snapshot.title !== "string" || typeof snapshot.bodyMarkdown !== "string"
    || (snapshot.metaDescription != null && typeof snapshot.metaDescription !== "string")
    || articleContentHash(snapshot) !== row.revision_hash
    || typeof row.slug !== "string"
    || !/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/u.test(row.slug)) return null;
  return {
    id: Number(row.id),
    slug: row.slug,
    title: snapshot.title,
    metaDescription: typeof snapshot.metaDescription === "string" ? snapshot.metaDescription : null,
    // The snapshot is authoritative. Never expose mutable body_html/current text;
    // use the same HTML-escaping renderer as the original approved revision.
    bodyHtml: renderMarkdown(snapshot.bodyMarkdown),
    structuredData: snapshot.structuredData && typeof snapshot.structuredData === "object" && !Array.isArray(snapshot.structuredData)
      ? snapshot.structuredData as Record<string, unknown> : null,
    articleType: row.article_type,
    publishedAt: iso(row.published_at),
    updatedAt: iso(row.updated_at),
    url: hostedArticleUrl(site.slug, row.slug, env) || `${site.origin}/${row.slug}`,
  };
}

// Publication state belongs to a destination. WordPress's pending/unknown/success
// cannot hide or resurrect a hosted page. Later unconfirmed updates keep serving
// the last confirmed hosted revision; confirmed hosted unpublish hides it.
const HOSTED_ARTICLES = `with hosted_articles as (
  select article.id, article.article_type,
         coalesce(nullif(delivered.provider_ref->>'slug', ''), delivered.provider_operation_id) as slug,
         revision.snapshot as revision_snapshot, revision.content_hash as revision_hash,
         delivered.completed_at as updated_at,
         (select min(first_delivery.completed_at) from site_article_publications first_delivery
           where first_delivery.article_id=article.id and first_delivery.destination_id=delivered.destination_id
             and first_delivery.status='published' and first_delivery.outcome='success'
             and first_delivery.reconcile_state='confirmed' and first_delivery.action in ('publish','update')) as published_at
    from site_articles article
    join sites site on site.id=article.site_id and site.status='active' and site.verification_state='verified'
    join lateral (
      select publication.* from site_article_publications publication
      join site_destinations destination on destination.id=publication.destination_id
        and destination.site_id=article.site_id and destination.kind='site_hosted' and destination.status='active'
      where publication.article_id=article.id and publication.status='published'
        and publication.outcome='success' and publication.reconcile_state='confirmed'
      order by publication.completed_at desc nulls last, publication.id desc limit 1
    ) delivered on delivered.action in ('publish','update')
    join site_article_revisions revision on revision.article_id=article.id and revision.version=delivered.article_version
   where article.site_id=$1
)`;

export async function listHostedArticles(db: Queryable, site: HostedSite, limit = 100, env: Record<string, string | undefined> = process.env): Promise<HostedArticle[]> {
  const result = await db.query<ArticleRow>(
    `${HOSTED_ARTICLES} select * from hosted_articles
      order by published_at desc nulls last, id desc limit $2`,
    [site.id, Number.isFinite(limit) ? Math.min(500, Math.max(1, Math.trunc(limit))) : 100],
  );
  return result.rows.flatMap((row) => { const article = toArticle(row, site, env); return article ? [article] : []; });
}

export async function loadHostedArticle(db: Queryable, site: HostedSite, articleSlug: string, env: Record<string, string | undefined> = process.env): Promise<HostedArticle | null> {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/u.test(articleSlug)) return null;
  const result = await db.query<ArticleRow>(
    `${HOSTED_ARTICLES} select * from hosted_articles where slug=$2`,
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

/** JSON embedded in an HTML script must not contain a literal script terminator. */
export function serializeHostedJsonLd(value: Record<string, unknown>): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}
