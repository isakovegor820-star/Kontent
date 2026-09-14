import { NextRequest } from "next/server";

import { enqueueSiteArticleJob, hasSiteArticlesWorker } from "@/lib/site-articles-queue";
import { summarizeProbeRun } from "@/lib/site-probe/questions.mjs";

import { jsonWithRequest, requireSite, resolveSiteRoute, siteErrorResponse } from "../../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

type ProbeRow = {
  run_key: string;
  question_key: string;
  question_text: string;
  engine: string;
  brand_mentioned: boolean;
  site_cited: boolean;
  competitors_mentioned: Array<{ name: string; kind: string }>;
  answer_excerpt: string | null;
  status: string;
  checked_at: Date;
};

export async function GET(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.read", { label: "/api/sites/:id/probe GET" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool } = resolved.context;
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const runs = await pool.query<{ run_key: string; checked_at: Date }>(
      `select run_key, max(checked_at) as checked_at from site_visibility_probes where site_id = $1 group by run_key order by max(checked_at) desc limit 12`,
      [found.site.id],
    );
    const latest = runs.rows[0];
    const rows = latest
      ? (await pool.query<ProbeRow>(
        `select run_key, question_key, question_text, engine, brand_mentioned, site_cited, competitors_mentioned, answer_excerpt, status, checked_at
           from site_visibility_probes where site_id = $1 and run_key = $2 order by question_key, engine`,
        [found.site.id, latest.run_key],
      )).rows
      : [];
    const history = [];
    for (const run of runs.rows) {
      const runRows = run.run_key === latest?.run_key
        ? rows
        : (await pool.query<ProbeRow>(`select question_key, engine, status, brand_mentioned, site_cited, competitors_mentioned from site_visibility_probes where site_id = $1 and run_key = $2`, [found.site.id, run.run_key])).rows;
      history.push({ runKey: run.run_key, checkedAt: run.checked_at, ...summarizeProbeRun(runRows) });
    }
    return jsonWithRequest({
      latest: latest ? { runKey: latest.run_key, checkedAt: latest.checked_at, ...summarizeProbeRun(rows), rows: rows.map((row) => ({
        questionKey: row.question_key, question: row.question_text, engine: row.engine, brandMentioned: row.brand_mentioned,
        siteCited: row.site_cited, competitors: row.competitors_mentioned, excerpt: row.answer_excerpt, status: row.status,
      })) } : null,
      history,
    }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/probe GET", requestId);
  }
}

export async function POST(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "content.create", { mutation: true, label: "/api/sites/:id/probe POST" });
  if (!resolved.ok) return resolved.response;
  const { requestId } = resolved.context;
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    if (found.site.verification_state !== "verified") return jsonWithRequest({ error: "domain_unverified" }, 409, requestId);
    if (!found.site.latest_profile_id) return jsonWithRequest({ error: "profile_required" }, 409, requestId);
    if (!(await hasSiteArticlesWorker())) return jsonWithRequest({ error: "worker_unavailable" }, 503, requestId);
    await enqueueSiteArticleJob("probe", { siteId: Number(found.site.id) }, { jobId: `site-articles-probe-${found.site.id}-${new Date().toISOString().slice(0, 10)}` });
    return jsonWithRequest({ ok: true, queued: true }, 202, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/probe POST", requestId);
  }
}
