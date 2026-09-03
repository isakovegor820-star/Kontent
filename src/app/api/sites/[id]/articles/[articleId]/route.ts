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
} from "@/lib/sites/articles-service";
import { SiteServiceError } from "@/lib/sites/service";
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
    const profile = found.site.latest_profile_id
      ? await pool.query<{ linkable_pages: Array<{ url: string }> }>(`select linkable_pages from site_profiles where id = $1`, [found.site.latest_profile_id])
      : { rows: [] as Array<{ linkable_pages: Array<{ url: string }> }> };
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { row, validation } = await editSiteArticle(client, {
        site: found.site, article, userId,
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
  if (!(action in ACTION_PERMISSION)) {
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

    if (action === "regenerate") {
      if (!["failed", "rejected", "needs_review"].includes(article.status)) throw new SiteServiceError("article_not_regenerable", 409);
      await pool.query(`update site_articles set status = 'draft', status_reason = null, version = version + 1, updated_at = now() where id = $1`, [articleId]);
      await enqueueSiteArticleJob("generate", { articleId }, { jobId: `site-articles-generate-${articleId}-v${Number(article.version) + 1}` });
      return jsonWithRequest({ ok: true, status: "draft" }, 202, requestId);
    }

    const client = await pool.connect();
    let publications: Array<{ id: number | string }> = [];
    let result: Record<string, unknown> = {};
    try {
      await client.query("begin");
      if (action === "approve") {
        const approved = await approveSiteArticle(client, { site: found.site, article, userId });
        publications = approved.publications;
        result = { article: serializeSiteArticle(approved.row), edited: approved.edited, destinations: approved.destinations, verified: approved.verified };
      } else if (action === "reject") {
        const rejected = await rejectSiteArticle(client, { site: found.site, article, userId, reason: body.reason });
        result = { article: serializeSiteArticle(rejected) };
      } else {
        publications = await requestPublication(client, { site: found.site, article, action });
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
