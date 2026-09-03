import { createHash } from "node:crypto";

import { SITE_ARTICLE_TYPES } from "./types.mjs";

/**
 * Общие операции над материалами, которые нужны и API (одобрение, правка), и worker'у
 * (генерация, публикация). Только SQL и детерминированная логика — без сети и моделей.
 */

export const SITE_ARTICLE_FIELDS = `id, site_id, project_id, user_id, article_type, origin, source_key, source_ref,
  title, slug, meta_description, body_markdown, body_html, internal_links, structured_data, evidence_keys,
  similarity_check, quality, generation, version, status, status_reason, approved_by, approved_version,
  approved_at, published_url, provider_ref, scheduled_at, published_at, retired_at, created_at, updated_at`;

export function articleContentHash(article) {
  return createHash("sha256")
    .update(JSON.stringify({
      title: article.title ?? "",
      metaDescription: article.metaDescription ?? article.meta_description ?? null,
      bodyMarkdown: article.bodyMarkdown ?? article.body_markdown ?? "",
      structuredData: article.structuredData ?? article.structured_data ?? null,
    }), "utf8")
    .digest("hex");
}

export async function recordArticleRevision(db, { article, version, authorUserId = null, changeKind }) {
  await db.query(
    `insert into site_article_revisions (article_id, version, author_user_id, change_kind, content_hash, snapshot)
     values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (article_id, version) do nothing`,
    [
      Number(article.id),
      Number(version),
      authorUserId,
      changeKind,
      articleContentHash(article),
      JSON.stringify({
        title: article.title ?? "",
        metaDescription: article.metaDescription ?? article.meta_description ?? null,
        bodyMarkdown: article.bodyMarkdown ?? article.body_markdown ?? "",
        structuredData: article.structuredData ?? article.structured_data ?? null,
        status: article.status ?? null,
      }),
    ],
  );
}

/** Уникальный slug в пределах сайта: base, base-2, base-3, … */
export async function nextUniqueSlug(db, { siteId, base, excludeArticleId = null }) {
  const root = String(base || "").slice(0, 110) || "material";
  for (let attempt = 1; attempt <= 50; attempt += 1) {
    const candidate = attempt === 1 ? root : `${root}-${attempt}`;
    const taken = await db.query(
      `select id from site_articles where site_id = $1 and slug = $2 and ($3::bigint is null or id <> $3) limit 1`,
      [siteId, candidate, excludeArticleId],
    );
    if (!taken.rows[0]) return candidate;
  }
  throw new Error("site_article_slug_exhausted");
}

export function publicationIdempotencyKey({ articleId, destinationId, version, action = "publish" }) {
  return `site-article:${articleId}:${destinationId}:v${version}:${action}`;
}

/**
 * Создаёт операции публикации для версии статьи по каждому активному назначению.
 * Повторный вызов для той же версии идемпотентен: возвращает существующие строки.
 */
export async function createArticlePublications(db, { article, destinations, action = "publish" }) {
  const rows = [];
  for (const destination of destinations) {
    const stored = await db.query(
      `insert into site_article_publications
         (article_id, destination_id, article_version, idempotency_key, action, status)
       values ($1, $2, $3, $4, $5, 'pending')
       on conflict (idempotency_key) do update set updated_at = site_article_publications.updated_at
       returning id, article_id, destination_id, article_version, idempotency_key, action, status`,
      [
        Number(article.id),
        Number(destination.id),
        Number(article.version),
        publicationIdempotencyKey({ articleId: article.id, destinationId: destination.id, version: article.version, action }),
        action,
      ],
    );
    rows.push(stored.rows[0]);
  }
  return rows;
}

export async function activeDestinationsForSite(db, siteId) {
  const result = await db.query(
    `select id, site_id, kind, base_url, credentials, credential_state, section_path, settings, status
       from site_destinations
      where site_id = $1 and status = 'active'
        and credential_state in ('ready', 'not_required')
      order by kind`,
    [siteId],
  );
  return result.rows;
}

export function articlePayload(article, { publishAt = null } = {}) {
  return {
    slug: article.slug,
    title: article.title,
    metaDescription: article.meta_description ?? article.metaDescription ?? null,
    bodyHtml: article.body_html ?? article.bodyHtml ?? "",
    structuredData: article.structured_data ?? article.structuredData ?? null,
    publishAt,
  };
}

export function articleTypeLabel(type) {
  return SITE_ARTICLE_TYPES[type]?.label || type;
}

/** Одобрение без правок продлевает серию; правка или отклонение — обнуляет (решение 2). */
export async function applyApprovalStreak(db, { siteId, edited, rejected }) {
  if (rejected || edited) {
    await db.query(`update sites set approved_streak = 0, updated_at = now() where id = $1`, [siteId]);
    return;
  }
  await db.query(`update sites set approved_streak = approved_streak + 1, updated_at = now() where id = $1`, [siteId]);
}
