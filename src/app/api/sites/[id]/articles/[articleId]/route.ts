import { NextRequest } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { enqueueSiteArticleJob } from "@/lib/site-articles-queue";
import {
  approveSiteArticle,
  editSiteArticle,
  findSiteArticle,
  rejectSiteArticle,
  requestPublication,
  serializeSiteArticle,
  type SiteArticleRow,
} from "@/lib/sites/articles-service";
import { findSiteForProject, SiteServiceError } from "@/lib/sites/service";
import type { ProjectPermission } from "@/lib/project-permissions";

import { jsonWithRequest, parseSiteId, requireSite, resolveSiteRoute, siteErrorResponse } from "../../../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; articleId: string }> };
type Action = "approve" | "reject" | "publish" | "update" | "unpublish" | "regenerate";

const ACTION_PERMISSION: Record<Action, ProjectPermission> = {
  approve: "content.approve",
  reject: "content.review",
  publish: "content.publish",
  update: "content.publish",
  unpublish: "content.publish",
  regenerate: "content.create",
};

function requireReviewedRevision(body: Record<string, unknown>, article: SiteArticleRow) {
  if (!Number.isSafeInteger(body.version) || Number(body.version) < 1 || typeof body.status !== "string") {
    throw new SiteServiceError("article_revision_required", 400);
  }
  if (body.version !== Number(article.version) || body.status !== article.status) {
    throw new SiteServiceError("article_revision_conflict", 409);
  }
}

export async function GET(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.read", { label: "/api/sites/:id/articles/:articleId GET" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool } = resolved.context;
  const params = await context.params;
  const articleId = parseSiteId(params.articleId);
  if (!articleId) return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  try {
    const found = await requireSite(resolved.context, params.id);
    if (!found.ok) return found.response;
    const article = await findSiteArticle(pool, Number(found.site.id), articleId);
    if (!article) return jsonWithRequest({ error: "not_found" }, 404, requestId);
    const revisions = await pool.query<{ version: string | number; change_kind: string; author_user_id: string | number | null; created_at: Date }>(
      `select version, change_kind, author_user_id, created_at from site_article_revisions where article_id = $1 order by version desc, id desc limit 20`,
      [articleId],
    );
    const publications = await pool.query<Record<string, unknown>>(
      `select p.id, p.destination_id, d.kind, p.article_version, p.action, p.status, p.outcome, p.published_url, p.last_error_code, p.attempts, p.updated_at
         from site_article_publications p join site_destinations d on d.id = p.destination_id
        where p.article_id = $1 order by p.id desc limit 20`,
      [articleId],
    );
    return jsonWithRequest({
      ok: true,
      article: serializeSiteArticle(article, { includeBody: true }),
      revisions: revisions.rows.map((row) => ({ version: Number(row.version), changeKind: row.change_kind, authorUserId: row.author_user_id === null ? null : Number(row.author_user_id), createdAt: row.created_at })),
      publications: publications.rows,
    }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/articles/:articleId GET", requestId);
  }
}

export async function PATCH(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "content.edit", { mutation: true, label: "/api/sites/:id/articles/:articleId PATCH" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool, userId } = resolved.context;
  const params = await context.params;
  const articleId = parseSiteId(params.articleId);
  if (!articleId) return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  }
  try {
    const found = await requireSite(resolved.context, params.id);
    if (!found.ok) return found.response;
    const article = await findSiteArticle(pool, Number(found.site.id), articleId);
    if (!article) return jsonWithRequest({ error: "not_found" }, 404, requestId);
    requireReviewedRevision(body, article);
    const profile = found.site.latest_profile_id
      ? await pool.query<{ linkable_pages: Array<{ url: string }> }>(`select linkable_pages from site_profiles where id = $1`, [found.site.latest_profile_id])
      : { rows: [] as Array<{ linkable_pages: Array<{ url: string }> }> };
    const client = await pool.connect();
    try {
      await client.query("begin");
      const article = await findSiteArticle(client, Number(found.site.id), articleId, true);
      if (!article) throw new SiteServiceError("not_found", 404);
      const site = await findSiteForProject(client, Number(found.site.id), Number(found.site.project_id), true);
      if (!site) throw new SiteServiceError("not_found", 404);
      const { row, validation } = await editSiteArticle(client, {
        site, article, userId,
        title: body.title, metaDescription: body.metaDescription, bodyMarkdown: body.bodyMarkdown,
        linkablePages: profile.rows[0]?.linkable_pages || [],
      });
      await client.query("commit");
      return jsonWithRequest({ ok: true, article: serializeSiteArticle(row, { includeBody: true }), issues: validation.issues, publishable: validation.ok }, 200, requestId);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/articles/:articleId PATCH", requestId);
  }
}

/** Действия над материалом: approve | reject | publish | update | unpublish | regenerate. */
export async function POST(req: NextRequest, context: Context) {
  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBodyValue(req);
  } catch {
    body = {};
  }
  const action = String(body.action || "") as Action;
  if (!Object.hasOwn(ACTION_PERMISSION, action)) {
    const bad = await resolveSiteRoute(req, "project.read", { mutation: true, label: "/api/sites/:id/articles/:articleId POST" });
    return bad.ok ? jsonWithRequest({ error: "bad_request" }, 400, bad.context.requestId) : bad.response;
  }
  const resolved = await resolveSiteRoute(req, ACTION_PERMISSION[action], { mutation: true, label: "/api/sites/:id/articles/:articleId POST" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool, userId, projectId } = resolved.context;
  const params = await context.params;
  const articleId = parseSiteId(params.articleId);
  if (!articleId) return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  try {
    const found = await requireSite(resolved.context, params.id);
    if (!found.ok) return found.response;
    const article = await findSiteArticle(pool, Number(found.site.id), articleId);
    if (!article) return jsonWithRequest({ error: "not_found" }, 404, requestId);
    requireReviewedRevision(body, article);

    if (action === "regenerate") {
      if (!["failed", "rejected", "needs_review"].includes(article.status)) throw new SiteServiceError("article_not_regenerable", 409);
      const updated = await pool.query<{ version: number | string }>(
        `update site_articles set status = 'draft', status_reason = null, version = version + 1, generation = null,
                approved_by = null, approved_version = null, approved_at = null,
                generation_requested_by_user_id = $5, worker_lease_token = null,
                worker_heartbeat_at = null, updated_at = now()
          where id = $1 and site_id = $2 and project_id = $3 and version = $4 and status = $6
          returning version`,
        [articleId, found.site.id, found.site.project_id, article.version, userId, article.status],
      );
      if (!updated.rows[0]) throw new SiteServiceError("article_revision_conflict", 409);
      const version = Number(updated.rows[0].version);
      await enqueueSiteArticleJob("generate", { articleId, version }, { jobId: `site-articles-generate-${articleId}-v${version}` });
      return jsonWithRequest({ ok: true, status: "draft" }, 202, requestId);
    }

    const client = await pool.connect();
    let publications: Array<{ id: number | string }> = [];
    let result: Record<string, unknown> = {};
    try {
      await client.query("begin");
      const article = await findSiteArticle(client, Number(found.site.id), articleId, true);
      if (!article) throw new SiteServiceError("not_found", 404);
      const site = await findSiteForProject(client, Number(found.site.id), Number(found.site.project_id), true);
      if (!site) throw new SiteServiceError("not_found", 404);
      if (action === "approve") {
        const approved = await approveSiteArticle(client, { site, article, userId });
        publications = approved.publications;
        result = { article: serializeSiteArticle(approved.row), edited: approved.edited, destinations: approved.destinations, verified: approved.verified };
      } else if (action === "reject") {
        const rejected = await rejectSiteArticle(client, { site, article, userId, reason: body.reason });
        result = { article: serializeSiteArticle(rejected) };
      } else {
        publications = await requestPublication(client, { site, article, action, userId });
        result = { publications: publications.length };
      }
      await client.query(
        `insert into audit_events (project_id, actor_user_id, action, entity_type, entity_id, safe_data, request_id)
         values ($1, $2, $3, 'site_article', $4, $5::jsonb, $6)`,
        [projectId, userId, `site.article.${action}`, String(articleId), JSON.stringify({ siteId: Number(found.site.id), version: Number(article.version), publications: publications.length }), requestId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    for (const publication of publications) {
      await enqueueSiteArticleJob("publish", { publicationId: Number(publication.id) }).catch(() => undefined);
    }
    return jsonWithRequest({ ok: true, action, ...result, queued: publications.length }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/articles/:articleId POST", requestId);
  }
}
