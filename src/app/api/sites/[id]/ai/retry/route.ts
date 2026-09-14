import { withProjectRoute } from "@/lib/project-route";
import { NextRequest } from "next/server";
import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { enqueueSiteArticleJob, hasSiteArticlesWorker } from "@/lib/site-articles-queue";
import { jsonWithRequest, parseSiteId, requireSite, resolveSiteRoute, siteErrorResponse } from "../../../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

async function handlePOST(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "content.create", { mutation: true, label: "/api/sites/:id/ai/retry POST" });
  if (!resolved.ok) return resolved.response;
  const { pool, requestId } = resolved.context;
  let body: Record<string, unknown>;
  try { body = await readJsonBodyValue(req); }
  catch { return jsonWithRequest({ error: "bad_request" }, 400, requestId); }
  if (body.target !== "profile" && body.target !== "report") return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    if (found.site.status !== "active") return jsonWithRequest({ error: "site_disconnected" }, 409, requestId);
    if (!await hasSiteArticlesWorker()) return jsonWithRequest({ error: "worker_unavailable" }, 503, requestId);
    if (body.target === "profile") {
      if (!found.site.latest_profile_id) return jsonWithRequest({ error: "profile_required" }, 409, requestId);
      const updated = await pool.query(
        `update site_profiles set refined_at = null, ai_classification = '{"status":"pending","attempts":0}'::jsonb,
                worker_lease_token = null, worker_heartbeat_at = null
          where id = $1 and site_id = $2 and ai_classification->>'status' = 'failed'
            and (worker_lease_token is null or worker_heartbeat_at < now() - interval '2 minutes') returning id`,
        [found.site.latest_profile_id, found.site.id],
      );
      if (!updated.rows[0]) return jsonWithRequest({ error: "ai_task_not_retryable" }, 409, requestId);
      await enqueueSiteArticleJob("refine", { profileId: Number(updated.rows[0].id) }, { jobId: `site-profile-retry-${updated.rows[0].id}-${requestId}` });
    } else {
      const reportId = parseSiteId(String(body.reportId || ""));
      if (!reportId) return jsonWithRequest({ error: "bad_request" }, 400, requestId);
      const updated = await pool.query<{ interpretation_revision: number }>(
        `update site_reports set interpretation_status = 'pending', interpretation_revision = interpretation_revision + 1,
                interpretation = '{"status":"pending","attempts":0}'::jsonb, worker_lease_token = null, worker_heartbeat_at = null
          where id = $1 and site_id = $2 and status = 'ready' and interpretation_status = 'failed'
            and (worker_lease_token is null or worker_heartbeat_at < now() - interval '2 minutes') returning interpretation_revision`,
        [reportId, found.site.id],
      );
      if (!updated.rows[0]) return jsonWithRequest({ error: "ai_task_not_retryable" }, 409, requestId);
      const revision = Number(updated.rows[0].interpretation_revision);
      await enqueueSiteArticleJob("interpret", { reportId, revision }, { jobId: `site-interpretation-${reportId}-v${revision}` });
    }
    return jsonWithRequest({ ok: true, queued: true }, 202, requestId);
  } catch (error) { return siteErrorResponse(error, "/api/sites/:id/ai/retry POST", requestId); }
}

export const POST = withProjectRoute(handlePOST);
