// Д.9 — собрать план недели сейчас (кнопка «Собрать план») ДЛЯ ВЫБРАННОГО КАНАЛА.
// Строит воркер (ИИ + аналитика).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { ensureSettings, loadBrief, resolveChannel } from "@/lib/autopilot";
import { briefComplete } from "@/lib/brief";
import { isAutopilotBuildStale } from "@/lib/autopilot-build";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import {
  AUTOPILOT_PLANNING_MONTHS,
  isAutopilotEngine,
  isAutopilotPlanningWeeks,
  plannedPostCountForWeeks,
} from "@/lib/autopilot-config.mjs";
import { resolveAiEngineRuntime } from "@/lib/ai-engine-policy.mjs";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.create");
    const projectId = membership.projectId;
    const scope = { actorUserId: user.id, projectId };
    const body = (await req.json().catch(() => ({}))) as {
      channelId?: number;
      generationEngine?: unknown;
      planningMonths?: unknown;
      planningWeeks?: unknown;
      monthlyCampaignPlanId?: unknown;
    };
    const channelId = await resolveChannel(scope, body.channelId ?? null);
    if (!channelId) {
      return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    }

    // Без брифа ИИ не знает, о чём канал, и пишет наугад — план не собираем (ТЗ Д.9).
    const brief = await loadBrief(scope, channelId);
    if (!brief.ready || !briefComplete(brief)) {
      return NextResponse.json({ ok: false, error: "no_brief" }, { status: 422 });
    }

    const settings = await ensureSettings(scope, channelId);
    if (body.generationEngine != null && !isAutopilotEngine(body.generationEngine)) {
      return NextResponse.json({ ok: false, error: "bad_engine" }, { status: 422 });
    }
    const generationEngine = isAutopilotEngine(body.generationEngine)
      ? body.generationEngine
      : isAutopilotEngine(settings.generation_engine)
        ? settings.generation_engine
        : "navy-deepseek-pro";
    const monthlyCampaignPlanId = body.monthlyCampaignPlanId == null
      ? null
      : Number(body.monthlyCampaignPlanId);
    if (monthlyCampaignPlanId != null
        && (!Number.isSafeInteger(monthlyCampaignPlanId) || monthlyCampaignPlanId <= 0)) {
      return NextResponse.json({ ok: false, error: "bad_monthly_plan" }, { status: 422 });
    }
    if (monthlyCampaignPlanId != null) {
      const monthly = await pool.query(
        `select plan.id
           from monthly_campaign_plans plan
           join monthly_campaigns campaign
             on campaign.id = plan.campaign_id and campaign.project_id = plan.project_id
          where plan.id = $1 and plan.project_id = $2 and plan.status = 'approved'
            and campaign.is_archived = false
          limit 1`,
        [monthlyCampaignPlanId, projectId],
      );
      if (!monthly.rowCount) {
        return NextResponse.json({ ok: false, error: "monthly_plan_unavailable" }, { status: 409 });
      }
      if (body.planningMonths != null || (body.planningWeeks != null && Number(body.planningWeeks) !== 1)) {
        return NextResponse.json({ ok: false, error: "bad_horizon" }, { status: 422 });
      }
    }
    const requestedMonths = Number(body.planningMonths);
    const requestedWeeks = body.planningWeeks != null
      ? Number(body.planningWeeks)
      : body.planningMonths != null && AUTOPILOT_PLANNING_MONTHS.includes(requestedMonths)
        ? requestedMonths * 4
        : null;
    if (
      (body.planningMonths != null && !AUTOPILOT_PLANNING_MONTHS.includes(requestedMonths)) ||
      (requestedWeeks != null && !isAutopilotPlanningWeeks(requestedWeeks))
    ) {
      return NextResponse.json({ ok: false, error: "bad_horizon" }, { status: 422 });
    }
    const selectedPlanningWeeks = monthlyCampaignPlanId != null
      ? 1
      : requestedWeeks ?? settings.planning_weeks ?? settings.planning_months * 4;
    if (!isAutopilotPlanningWeeks(selectedPlanningWeeks)) {
      return NextResponse.json({ ok: false, error: "bad_horizon" }, { status: 422 });
    }
    const planningWeeks = Number(selectedPlanningWeeks);
    const planningMonths = Math.max(1, Math.min(3, Math.ceil(planningWeeks / 4)));
    const engineRuntime = resolveAiEngineRuntime(generationEngine);
    if (!engineRuntime.supported || !engineRuntime.configured) {
      return NextResponse.json({ ok: false, error: "engine_unavailable" }, { status: 422 });
    }
    const statsQueue = getStatsQueue();

    // Next.js only enqueues this work; worker.mjs executes it. Previously we returned `ok`
    // even when no worker existed, creating a perfectly valid job that nobody would ever take.
    if ((await statsQueue.getWorkersCount()) === 0) {
      return NextResponse.json(
        { ok: false, error: "worker_unavailable" },
        { status: 503 },
      );
    }

    // Плейсхолдер «собираю» — интерфейс покажет процесс; воркер заменит его готовым планом.
    // Чистим только этот канал: у соседнего канала свой план, и он тут ни при чём.
    // Одной транзакцией: снести старый план и не вставить новый — значит оставить человека
    // ни с чем. Порознь эти два запроса ровно это и позволяют.
    const tx = await pool.connect();
    let planId: string | null = null;
    let alreadyBuilding = false;
    try {
      await tx.query("begin");
      // Serialise clicks for one channel. The old code accepted every click after the HTTP
      // response and four identical jobs accumulated for this incident.
      await tx.query(
        `select 1 from autopilot_settings
          where project_id = $1 and channel_id = $2 for update`,
        [projectId, channelId],
      );
      await tx.query(
        `update autopilot_settings
            set generation_engine = $3,
                planning_months = $4,
                planning_weeks = $5,
                updated_at = now()
          where project_id = $1 and channel_id = $2`,
        [projectId, channelId, generationEngine, planningMonths, planningWeeks],
      );
      const current = (
        await tx.query(
          `select id, created_at, planning_months, planning_weeks, monthly_campaign_plan_id
             from autopilot_plan
            where project_id = $1 and channel_id = $2 and status = 'building'
            order by created_at desc limit 1`,
          [projectId, channelId],
        )
      ).rows[0];

      const currentPostCount = current
        ? plannedPostCountForWeeks(
            settings.post_frequency,
            current.planning_weeks ?? current.planning_months * 4,
          )
        : 0;
      if (current
          && Number(current.monthly_campaign_plan_id || 0) === Number(monthlyCampaignPlanId || 0)
          && !isAutopilotBuildStale(current.created_at, currentPostCount)) {
        planId = String(current.id);
        alreadyBuilding = true;
        await tx.query("commit");
      } else {
        if (current) {
          await tx.query(
            `update autopilot_plan set status = 'error', revision = revision + 1
              where id = $1 and project_id = $2 and channel_id = $3 and status = 'building'`,
            [current.id, projectId, channelId],
          );
        }
        // Готовый pending-план пока сохраняем. Если новый ИИ-запуск упадёт, человек не
        // потеряет старую неделю; если завершится — worker заменит старый план атомарно и
        // отменит только связанные с ним scheduled-посты. Удаляем лишь старый placeholder.
        await tx.query(
          `delete from autopilot_plan
            where project_id = $1 and channel_id = $2 and status = 'building'`,
          [projectId, channelId],
        );
        const inserted = await tx.query(
          `insert into autopilot_plan
             (project_id, user_id, channel_id, week_start, status, generation_engine,
              planning_months, planning_weeks, monthly_campaign_plan_id)
             values ($1, $2, $3, current_date, 'building', $4, $5, $6, $7) returning id`,
          [
            projectId, user.id, channelId, generationEngine, planningMonths, planningWeeks,
            monthlyCampaignPlanId,
          ],
        );
        planId = String(inserted.rows[0].id);
        await tx.query("commit");
      }
    } catch (err) {
      await tx.query("rollback").catch(() => {});
      throw err;
    } finally {
      tx.release();
    }

    if (alreadyBuilding) return NextResponse.json({ ok: true, building: true, planId });
    if (!planId) throw new Error("autopilot placeholder was not created");

    try {
      await statsQueue.add(
        "autopilot-plan",
        { projectId, userId: user.id, channelId, planId },
        {
          jobId: `autopilot-plan-${planId}`,
          removeOnComplete: true,
          attempts: 2,
          backoff: { type: "fixed", delay: 20000 },
        },
      );
    } catch (err) {
      // DB and Redis cannot share a transaction. Compensate explicitly so a Redis outage
      // becomes a retryable error card instead of another eternal spinner.
      await pool
        .query(
          `update autopilot_plan set status = 'error', revision = revision + 1
            where id = $1 and project_id = $2 and channel_id = $3 and status = 'building'`,
          [planId, projectId, channelId],
        )
        .catch(() => {});
      console.error("[/api/autopilot/generate] enqueue", err);
      return NextResponse.json({ ok: false, error: "queue_unavailable" }, { status: 503 });
    }
    return NextResponse.json({ ok: true, planId });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/autopilot/generate]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
