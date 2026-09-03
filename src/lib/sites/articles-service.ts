import type { Pool, PoolClient } from "pg";

import { validateArticle } from "../site-articles/generation.mjs";
import {
  SITE_ARTICLE_FIELDS,
  activeDestinationsForSite,
  applyApprovalStreak,
  articleTypeLabel,
  createArticlePublications,
  nextUniqueSlug,
  recordArticleRevision,
} from "../site-articles/service.mjs";
import { SITE_ARTICLE_TYPE_IDS, type SiteArticleType } from "../site-articles/types.mjs";
import { SiteServiceError, type SiteRow } from "./service";

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export type SiteArticleRow = {
  id: string | number;
  site_id: string | number;
  project_id: string | number;
  user_id: string | number;
  article_type: SiteArticleType;
  origin: string;
  source_key: string | null;
  source_ref: Record<string, unknown> | null;
  title: string;
  slug: string;
  meta_description: string | null;
  body_markdown: string;
  body_html: string | null;
  internal_links: unknown[];
  structured_data: Record<string, unknown> | null;
  evidence_keys: unknown[];
  similarity_check: Record<string, unknown> | null;
  quality: Record<string, unknown> | null;
  generation: Record<string, unknown> | null;
  version: string | number;
  status: string;
  status_reason: string | null;
  approved_by: string | number | null;
  approved_version: string | number | null;
  approved_at: Date | string | null;
  published_url: string | null;
  provider_ref: Record<string, unknown> | null;
  scheduled_at: Date | string | null;
  published_at: Date | string | null;
  retired_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function serializeSiteArticle(row: SiteArticleRow, { includeBody = false } = {}) {
  const preview = String(row.body_markdown || "").replace(/[#*>\[\]()]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 240);
  return {
    id: Number(row.id),
    siteId: Number(row.site_id),
    type: row.article_type,
    typeLabel: articleTypeLabel(row.article_type),
    origin: row.origin,
    sourceRef: row.source_ref,
    title: row.title,
    slug: row.slug,
    metaDescription: row.meta_description,
    preview,
    internalLinks: row.internal_links,
    structuredData: row.structured_data,
    similarity: row.similarity_check,
    quality: row.quality,
    generation: row.generation,
    version: Number(row.version),
    status: row.status,
    statusReason: row.status_reason,
    approvedAt: iso(row.approved_at),
    approvedVersion: row.approved_version === null ? null : Number(row.approved_version),
    publishedUrl: row.published_url,
    publishedAt: iso(row.published_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(includeBody ? { bodyMarkdown: row.body_markdown, bodyHtml: row.body_html } : {}),
  };
}

export async function listSiteArticles(db: Queryable, siteId: number, status: string | null = null, limit = 50) {
  const result = await db.query<SiteArticleRow>(
    `select ${SITE_ARTICLE_FIELDS} from site_articles
      where site_id = $1 and ($2::text is null or status = $2)
      order by case status when 'needs_review' then 0 when 'approved' then 1 when 'publishing' then 2 else 3 end, updated_at desc, id desc
      limit $3`,
    [siteId, status, Math.min(200, Math.max(1, limit))],
  );
  return result.rows;
}

export async function findSiteArticle(db: Queryable, siteId: number, articleId: number) {
  const result = await db.query<SiteArticleRow>(
    `select ${SITE_ARTICLE_FIELDS} from site_articles where id = $1 and site_id = $2`,
    [articleId, siteId],
  );
  return result.rows[0] ?? null;
}

export async function createManualArticle(db: Queryable, input: {
  site: SiteRow;
  userId: number;
  articleType: unknown;
  brief: unknown;
  title?: unknown;
}) {
  const type = String(input.articleType || "");
  if (!(SITE_ARTICLE_TYPE_IDS as readonly string[]).includes(type)) throw new SiteServiceError("article_type_invalid", 422);
  const brief = String(input.brief || "").trim().slice(0, 4_000);
  if (brief.length < 10) throw new SiteServiceError("brief_too_short", 422);
  const title = input.title ? String(input.title).trim().slice(0, 200) : null;
  const slug = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const inserted = await db.query<SiteArticleRow>(
    `insert into site_articles (site_id, project_id, user_id, article_type, origin, source_ref, slug, status)
     values ($1, $2, $3, $4, 'manual', $5::jsonb, $6, 'draft')
     returning ${SITE_ARTICLE_FIELDS}`,
    [input.site.id, input.site.project_id, input.userId, type, JSON.stringify({ kind: "manual", brief, title, question: title }), slug],
  );
  return inserted.rows[0];
}

/** Правка текста человеком: новая версия, ревизия `edited`, повторная структурная проверка. */
export async function editSiteArticle(db: Queryable, input: {
  site: SiteRow;
  article: SiteArticleRow;
  userId: number;
  title?: unknown;
  metaDescription?: unknown;
  bodyMarkdown?: unknown;
  linkablePages: Array<{ url: string }>;
}) {
  if (!["needs_review", "approved", "failed", "rejected"].includes(input.article.status)) throw new SiteServiceError("article_not_editable", 409);
  const validation = validateArticle({
    title: input.title === undefined ? input.article.title : String(input.title),
    metaDescription: input.metaDescription === undefined ? input.article.meta_description : String(input.metaDescription ?? ""),
    bodyMarkdown: input.bodyMarkdown === undefined ? input.article.body_markdown : String(input.bodyMarkdown),
    faq: undefined,
    organization: input.article.structured_data && input.article.structured_data["@type"] !== "FAQPage" ? input.article.structured_data : undefined,
  }, {
    type: input.article.article_type,
    allowedLinks: input.linkablePages.map((page) => page.url),
    sourceUrl: typeof input.article.source_ref?.url === "string" ? input.article.source_ref.url : null,
    site: { confirmedDomain: input.site.confirmed_domain, brandName: input.site.brand_name, canonicalUrl: input.site.canonical_url },
  });
  const slug = input.article.status === "published"
    ? input.article.slug
    : await nextUniqueSlug(db, { siteId: Number(input.site.id), base: validation.article.slug, excludeArticleId: Number(input.article.id) });
  const updated = await db.query<SiteArticleRow>(
    `update site_articles
        set title = $2, slug = $3, meta_description = $4, body_markdown = $5, body_html = $6,
            internal_links = $7::jsonb, structured_data = $8::jsonb,
            quality = $9::jsonb, version = version + 1, status = 'needs_review', status_reason = $10,
            approved_by = null, approved_version = null, approved_at = null, updated_at = now()
      where id = $1
      returning ${SITE_ARTICLE_FIELDS}`,
    [
      input.article.id, validation.article.title, slug, validation.article.metaDescription, validation.article.bodyMarkdown,
      validation.article.bodyHtml, JSON.stringify(validation.article.internalLinks),
      validation.article.structuredData ? JSON.stringify(validation.article.structuredData) : null,
      JSON.stringify({ issues: validation.issues, wordCount: validation.article.wordCount, editedByHuman: true }),
      validation.ok ? null : "quality_after_edit",
    ],
  );
  const row = updated.rows[0];
  await recordArticleRevision(db, { article: row, version: row.version, authorUserId: input.userId, changeKind: "edited" });
  return { row, validation };
}

async function hasHumanEdit(db: Queryable, articleId: number, version: number) {
  const result = await db.query<{ n: string | number }>(
    `select count(*)::int as n from site_article_revisions where article_id = $1 and version = $2 and change_kind = 'edited'`,
    [articleId, version],
  );
  return Number(result.rows[0]?.n || 0) > 0;
}

/**
 * Одобрение: фиксирует версию, продлевает или обнуляет серию и создаёт операции публикации
 * по активным назначениям, если домен подтверждён. Возвращает publications для постановки в очередь.
 */
export async function approveSiteArticle(db: Queryable, input: { site: SiteRow; article: SiteArticleRow; userId: number }) {
  if (!["needs_review", "approved", "failed"].includes(input.article.status)) throw new SiteServiceError("article_not_approvable", 409);
  const edited = await hasHumanEdit(db, Number(input.article.id), Number(input.article.version));
  const updated = await db.query<SiteArticleRow>(
    `update site_articles
        set status = 'approved', approved_by = $2, approved_version = version, approved_at = now(), status_reason = null, updated_at = now()
      where id = $1 returning ${SITE_ARTICLE_FIELDS}`,
    [input.article.id, input.userId],
  );
  const row = updated.rows[0];
  await recordArticleRevision(db, { article: row, version: row.version, authorUserId: input.userId, changeKind: "approved" });
  await applyApprovalStreak(db, { siteId: Number(input.site.id), edited, rejected: false });
  const destinations = input.site.verification_state === "verified" ? await activeDestinationsForSite(db, Number(input.site.id)) : [];
  const publications = destinations.length ? await createArticlePublications(db, { article: row, destinations, action: "publish" }) : [];
  return { row, publications, edited, destinations: destinations.length, verified: input.site.verification_state === "verified" };
}

export async function rejectSiteArticle(db: Queryable, input: { site: SiteRow; article: SiteArticleRow; userId: number; reason?: unknown }) {
  if (!["needs_review", "approved", "failed", "draft"].includes(input.article.status)) throw new SiteServiceError("article_not_rejectable", 409);
  const reason = String(input.reason || "rejected_by_reviewer").trim().slice(0, 80);
  const updated = await db.query<SiteArticleRow>(
    `update site_articles set status = 'rejected', status_reason = $2, updated_at = now() where id = $1 returning ${SITE_ARTICLE_FIELDS}`,
    [input.article.id, reason],
  );
  const row = updated.rows[0];
  await recordArticleRevision(db, { article: row, version: row.version, authorUserId: input.userId, changeKind: "rejected" });
  await applyApprovalStreak(db, { siteId: Number(input.site.id), edited: false, rejected: true });
  return row;
}

export async function requestPublication(db: Queryable, input: { site: SiteRow; article: SiteArticleRow; action: "publish" | "update" | "unpublish" }) {
  if (input.site.verification_state !== "verified") throw new SiteServiceError("domain_unverified", 409);
  if (input.action === "publish" && !["approved", "failed"].includes(input.article.status)) throw new SiteServiceError("article_not_approved", 409);
  if (input.action !== "publish" && input.article.status !== "published") throw new SiteServiceError("article_not_published", 409);
  const destinations = await activeDestinationsForSite(db, Number(input.site.id));
  if (!destinations.length) throw new SiteServiceError("no_active_destination", 409);
  if (input.action === "publish" && input.article.status === "failed") {
    await db.query(`update site_articles set status = 'approved', status_reason = null, updated_at = now() where id = $1`, [input.article.id]);
  }
  return createArticlePublications(db, { article: input.article, destinations, action: input.action });
}
