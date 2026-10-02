import { withProjectRoute } from "@/lib/project-route";
import { JsonBodyReadError, readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";

import { resolveChannel } from "@/lib/autopilot";
import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { planWebResearch } from "@/lib/web-research-plan.mjs";
import { enqueueWebResearch, WebResearchQueueUnavailableError } from "@/lib/web-research-queue";
import {
  cleanCategories,
  cleanFingerprints,
  cleanLanguage,
  cleanTopic,
  languageFromBrief,
  requestedChannelId,
  topicFromBrief,
} from "@/lib/web-research-request";
import {
  finishWebResearchRun,
  latestWebResearchRun,
  loadWebResearchFindings,
  markWebResearchFindings,
  startWebResearchRun,
  type WebResearchStoredFinding,
} from "@/lib/web-research-store.mjs";

export const runtime = "nodejs";

/** Форма сохранённого факта для клиента: только то, что показывает интерфейс. */
type WebResearchFindingPayload = {
  fingerprint: string;
  kind: WebResearchStoredFinding["kind"];
  claim: string;
  quote: string;
  title: string | null;
  legalStatusLabel: string | null;
  publishedAt: string;
  ageDays: number;
  numbers: string[];
  corroborationCount: number;
  trusted: boolean;
  status: WebResearchStoredFinding["status"];
  source: { url: string; domain: string; label: string; tier: string; tierLabel: string; trust: number };
};

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

function findingPayload(finding: WebResearchStoredFinding): WebResearchFindingPayload {
  return {
    fingerprint: finding.fingerprint,
    kind: finding.kind,
    claim: finding.claim,
    quote: finding.quote,
    title: finding.title,
    legalStatusLabel: finding.legalStatusLabel,
    publishedAt: finding.publishedAt,
    ageDays: finding.ageDays,
    numbers: finding.numbers,
    corroborationCount: finding.corroborationCount,
    trusted: finding.trusted,
    status: finding.status,
    source: {
      url: finding.source.url,
      domain: finding.source.domain,
      label: finding.source.label,
      tier: finding.source.tier,
      tierLabel: finding.source.tierLabel,
      trust: finding.source.trust,
    },
  };
}

/** Профиль канала: из него берётся тема, когда пользователь не задал её явно. */
async function loadChannelBrief(projectId: number, channelId: number) {
  return (
    await getPool().query<{ niche: string | null; rubrics: string[] | null; goal: string | null; language: string | null }>(
      `select nullif(btrim(niche), '') as niche,
              coalesce(rubrics, '{}'::text[]) as rubrics,
              nullif(btrim(goal), '') as goal,
              coalesce(nullif(btrim(language), ''), 'ru') as language
         from content_brief
        where project_id = $1 and channel_id = $2
        order by ready desc, updated_at desc
        limit 1`,
      [projectId, channelId],
    )
  ).rows[0];
}

async function handleGET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const requested = requestedChannelId(req.nextUrl.searchParams.get("channel"));
  if (Number.isNaN(requested)) return json({ error: "bad_channel" }, 422);
  const pool = getPool();
  try {
    const { projectId } = await requireSelectedProjectPermission(pool, user.id, "project.read");
    const channelId = await resolveChannel({ actorUserId: user.id, projectId }, requested);
    if (!channelId) return json({ error: requested ? "channel_not_found" : "no_channel" }, requested ? 404 : 422);
    const scope = { projectId, channelId };
    const run = await latestWebResearchRun(pool, scope);
    const findings = await loadWebResearchFindings(pool, scope, { limit: 40, statuses: ["new", "used"] });
    return json({ channelId, run, findings: findings.map(findingPayload) });
  } catch (error) {
    if (error instanceof ProjectAccessError) return json({ error: "access_denied" }, 403);
    console.error("[/api/web-research] GET", { errorName: error instanceof Error ? error.name : "Error" });
    return json({ error: "web_research_unavailable" }, 503);
  }
}

async function handlePOST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) return json({ error: "forbidden_origin" }, 403);
  const user = await getSessionUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try {
    body = await readJsonBodyValue(req) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof JsonBodyReadError) return json({ error: error.code }, error.status);
    return json({ error: "bad_request" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_request" }, 400);

  const action = body.action == null ? "run" : String(body.action);
  if (action !== "run" && action !== "dismiss" && action !== "mark_used") return json({ error: "bad_action" }, 422);

  // Выход в интернет стоит денег и внешних запросов: потолок на пользователя
  // обязателен, а при недоступном Redis лимит закрывается (fail-closed).
  const limit = await checkRateLimit(`web-research:user-${user.id}`, 10, 60, { failureMode: "closed" });
  if (!limit.allowed) return rateLimitResponse(limit);

  const pool = getPool();
  const requested = requestedChannelId(req.nextUrl.searchParams.get("channel"));
  if (Number.isNaN(requested)) return json({ error: "bad_channel" }, 422);

  try {
    const { projectId } = await requireSelectedProjectPermission(pool, user.id, action === "run" ? "content.create" : "project.read");
    const channelId = await resolveChannel({ actorUserId: user.id, projectId }, requested);
    if (!channelId) return json({ error: requested ? "channel_not_found" : "no_channel" }, requested ? 404 : 422);
    const scope = { projectId, channelId };

    if (action === "dismiss" || action === "mark_used") {
      const fingerprints = cleanFingerprints(body.fingerprints);
      if (!fingerprints.length) return json({ error: "empty_fingerprints" }, 422);
      const updated = await markWebResearchFindings(pool, scope, fingerprints, action === "dismiss" ? "dismissed" : "used");
      return json({ ok: true, updated });
    }

    const brief = await loadChannelBrief(projectId, channelId);
    const topic = cleanTopic(body.topic) || topicFromBrief(brief);
    if (!topic) return json({ error: "topic_required" }, 422);
    const categories = cleanCategories(body.categories);
    const language = cleanLanguage(body.language) || languageFromBrief(brief);

    let plan: ReturnType<typeof planWebResearch>;
    try {
      plan = planWebResearch({ topic, categories, language });
    } catch {
      return json({ error: "bad_plan" }, 422);
    }

    const runId = await startWebResearchRun(pool, scope, {
      triggerKind: "manual",
      topic: plan.topic,
      categories: plan.categories,
      language: plan.language,
      planFingerprint: plan.fingerprint,
      queries: plan.queries,
    });

    try {
      await enqueueWebResearch({ runId, userId: user.id, projectId, channelId });
    } catch (error) {
      if (!(error instanceof WebResearchQueueUnavailableError)) throw error;
      // Очередь недоступна — не выдаём успех. Строка запуска закрывается провалом:
      // иначе она навсегда осталась бы в статусе «идёт», интерфейс вечно показывал бы
      // незавершённое исследование, а планировщик считал бы канал только что
      // обслуженным и не запустил бы фоновое исследование ещё шесть часов.
      console.error("[/api/web-research] POST queue unavailable", { runId });
      await finishWebResearchRun(pool, runId, {
        status: "failed",
        log: [],
        stats: {},
        findingsCount: 0,
        rejectionsCount: 0,
        error: "research_queue_unavailable",
      }).catch(() => undefined);
      return json({
        error: "research_queue_unavailable",
        message: "Воркер исследования недоступен, поэтому Аврора не вышла в интернет. Запуск отменён — повторите попытку позже.",
        runId,
      }, 503);
    }

    return json({ ok: true, runId, plan }, 202);
  } catch (error) {
    if (error instanceof ProjectAccessError) return json({ error: "access_denied" }, 403);
    console.error("[/api/web-research] POST", { errorName: error instanceof Error ? error.name : "Error" });
    return json({ error: "web_research_unavailable" }, 503);
  }
}

export const GET = withProjectRoute(handleGET);
export const POST = withProjectRoute(handlePOST);
