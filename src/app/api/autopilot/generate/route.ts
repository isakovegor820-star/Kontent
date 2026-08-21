// Д.9 — собрать план недели сейчас (кнопка «Собрать план») ДЛЯ ВЫБРАННОГО КАНАЛА.
// Строит воркер (ИИ + аналитика).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getAutopilotQueue } from "@/lib/queue";
import { ensureSettings, loadBrief, resolveChannel } from "@/lib/autopilot";
import { briefComplete } from "@/lib/brief";
import { isAutopilotBuildStale } from "@/lib/autopilot-build";
import { autopilotBuildActivityAt } from "@/lib/autopilot-build-progress.mjs";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import {
  AUTOPILOT_PLANNING_MONTHS,
  DEFAULT_AUTOPILOT_ENGINE,
  isAutopilotEngine,
  isAutopilotPlanningWeeks,
  plannedPostCountForWeeks,
} from "@/lib/autopilot-config.mjs";
import { resolveAiEngineRuntime } from "@/lib/ai-engine-policy.mjs";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { selectAutopilotNewsSources } from "@/lib/autopilot-source-selection";
import { normalizeAutopilotQuickSettings } from "@/lib/autopilot-style.mjs";
import { autopilotCandidateCount } from "@/lib/autopilot-candidate-selection.mjs";
import { GrowthArtifactLinkError, linkGrowthMovePlanInTransaction } from "@/lib/growth";

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
      quickSettings?: unknown;
      growthMoveId?: unknown;
    };
    const channelId = await resolveChannel(scope, body.channelId ?? null);
    if (!channelId) {
      return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    }
    const growthMoveId = body.growthMoveId == null ? null : Number(body.growthMoveId);
    if (growthMoveId != null && (!Number.isSafeInteger(growthMoveId) || growthMoveId <= 0)) {
      return NextResponse.json({ ok: false, error: "bad_growth_move" }, { status: 422 });
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
        : DEFAULT_AUTOPILOT_ENGINE;
    const monthlyCampaignPlanId = body.monthlyCampaignPlanId == null
      ? null
      : Number(body.monthlyCampaignPlanId);
    let monthlyPostFrequency: number | null = null;
    if (monthlyCampaignPlanId != null
        && (!Number.isSafeInteger(monthlyCampaignPlanId) || monthlyCampaignPlanId <= 0)) {
      return NextResponse.json({ ok: false, error: "bad_monthly_plan" }, { status: 422 });
    }
    if (monthlyCampaignPlanId != null) {
      const monthly = await pool.query(
        `select plan.id, campaign.posts_per_week
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
      monthlyPostFrequency = Math.max(
        1,
        Math.min(7, Math.round(Number(monthly.rows[0]?.posts_per_week) || 1)),
      );
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
    const generationPostFrequency = monthlyPostFrequency ?? Math.max(
      1,
      Math.min(7, Math.round(Number(settings.post_frequency) || 5)),
    );
    const publicationTargetCount = plannedPostCountForWeeks(generationPostFrequency, planningWeeks);
    // Approved monthly items already define an exact, immutable set. Standalone weekly
    // builds get a proportional reserve; only the selected publication target can enter
    // approval and scheduling.
    const candidateCount = monthlyCampaignPlanId == null
      ? autopilotCandidateCount(publicationTargetCount)
      : publicationTargetCount;
    const quickSettings = normalizeAutopilotQuickSettings(
      body.quickSettings ?? settings.quick_settings,
    );
    const engineRuntime = resolveAiEngineRuntime(generationEngine);
    if (!engineRuntime.supported || !engineRuntime.configured) {
      return NextResponse.json({ ok: false, error: "engine_unavailable" }, { status: 422 });
    }
    const autopilotQueue = getAutopilotQueue();

    // Next.js only enqueues this work; worker.mjs executes it. Previously we returned `ok`
    // even when no worker existed, creating a perfectly valid job that nobody would ever take.
    if ((await autopilotQueue.getWorkersCount()) === 0) {
      return NextResponse.json(
        { ok: false, error: "worker_unavailable" },
        { status: 503 },
      );
    }

    // Source selection belongs to Autopilot, not to the user. The catalog is curated and
    // SSRF-safe; ranking is deterministic from the confirmed channel brief. Persist the
    // server-owned perimeter so the weekly worker uses the same sources without another UI.
    const newsSources = selectAutopilotNewsSources(brief);
    await pool.query(
      `update autopilot_settings
          set news_sources = $3::jsonb, quick_settings = $4::jsonb,
              updated_at = now()
        where project_id = $1 and channel_id = $2`,
      [projectId, channelId, JSON.stringify(newsSources), JSON.stringify(quickSettings)],
    );

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
                quick_settings = $6::jsonb,
                updated_at = now()
          where project_id = $1 and channel_id = $2`,
        [
          projectId,
          channelId,
          generationEngine,
          planningMonths,
          planningWeeks,
          JSON.stringify(quickSettings),
        ],
      );
      const current = (
        await tx.query(
          `select id, created_at, build_activity_at, items, generation_engine,
                  generation_post_frequency, expected_post_count, publication_target_count,
                  candidate_count, planning_months,
                  planning_weeks, monthly_campaign_plan_id, quick_settings
             from autopilot_plan
            where project_id = $1 and channel_id = $2 and status = 'building'
            order by created_at desc limit 1`,
          [projectId, channelId],
        )
      ).rows[0];

      const currentPostCount = Number(current?.candidate_count || current?.expected_post_count) || 0;
      if (current
          && Number(current.monthly_campaign_plan_id || 0) === Number(monthlyCampaignPlanId || 0)
          && current.generation_engine === generationEngine
          && Number(current.generation_post_frequency) === generationPostFrequency
          && Number(current.publication_target_count || current.expected_post_count) === publicationTargetCount
          && Number(current.candidate_count || current.expected_post_count) === candidateCount
          && Number(current.planning_months) === planningMonths
          && Number(current.planning_weeks) === planningWeeks
          && JSON.stringify(normalizeAutopilotQuickSettings(current.quick_settings)) === JSON.stringify(quickSettings)
          && !isAutopilotBuildStale(
            current.build_activity_at
              || autopilotBuildActivityAt(current.created_at, current.items),
            currentPostCount,
          )) {
        planId = String(current.id);
        alreadyBuilding = true;
        if (growthMoveId != null) {
          await linkGrowthMovePlanInTransaction({
            db: tx, projectId, actorUserId: user.id, moveId: growthMoveId,
            planId: Number(planId), channelId,
          });
        }
        await tx.query("commit");
      } else {
        if (current) {
          await tx.query(
            `update autopilot_repair_operations
                set status = 'failed', terminal_outcome = 'cancelled',
                    diagnostic = '{"code":"superseded_by_new_build"}'::jsonb,
                    completed_at = now(), updated_at = now()
              where plan_id = $1 and project_id = $2 and channel_id = $3
                and status in ('queued', 'processing')`,
            [current.id, projectId, channelId],
          );
          await tx.query(
            `update autopilot_plan
                set status = 'error', rules = 'cancelled', terminal_outcome = 'cancelled',
                    revision = revision + 1
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
              generation_post_frequency, expected_post_count, publication_target_count,
              candidate_count, planning_months, planning_weeks, monthly_campaign_plan_id,
              quick_settings, build_activity_at)
             values ($1, $2, $3, current_date, 'building', $4, $5, $6, $6, $7,
                     $8, $9, $10, $11::jsonb, now())
             returning id`,
          [
            projectId, user.id, channelId, generationEngine, generationPostFrequency,
            publicationTargetCount, candidateCount, planningMonths, planningWeeks, monthlyCampaignPlanId,
            JSON.stringify(quickSettings),
          ],
        );
        planId = String(inserted.rows[0].id);
        if (growthMoveId != null) {
          await linkGrowthMovePlanInTransaction({
            db: tx, projectId, actorUserId: user.id, moveId: growthMoveId,
            planId: Number(planId), channelId,
          });
        }
        await tx.query("commit");
      }
    } catch (err) {
      await tx.query("rollback").catch(() => {});
      throw err;
    } finally {
      tx.release();
    }

    if (alreadyBuilding) {
      return NextResponse.json({
        ok: true,
        building: true,
        planId,
        publicationTargetCount,
        candidateCount,
      });
    }
    if (!planId) throw new Error("autopilot placeholder was not created");

    try {
      await autopilotQueue.add(
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
    return NextResponse.json({ ok: true, planId, publicationTargetCount, candidateCount });
  } catch (err) {
    if (err instanceof GrowthArtifactLinkError) {
      return NextResponse.json({ ok: false, error: err.code }, { status: 409 });
    }
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/autopilot/generate]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.create");
    const projectId = membership.projectId;
    const body = (await req.json().catch(() => ({}))) as { channelId?: number };
    const channelId = await resolveChannel(
      { actorUserId: user.id, projectId },
      body.channelId ?? null,
    );
    if (!channelId) {
      return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    }

    const tx = await pool.connect();
    let planId: string | null = null;
    let repairJobId: string | null = null;
    try {
      await tx.query("begin");
      await tx.query(
        `select 1 from autopilot_settings
          where project_id = $1 and channel_id = $2 for update`,
        [projectId, channelId],
      );
      const cancelled = await tx.query(
        `update autopilot_plan
            set status = 'error', rules = 'cancelled', terminal_outcome = 'cancelled',
                revision = revision + 1
          where id = (
            select id from autopilot_plan
             where project_id = $1 and channel_id = $2 and status = 'building'
             order by created_at desc limit 1
             for update
          )
          returning id, last_repair_job_id`,
        [projectId, channelId],
      );
      planId = cancelled.rows[0]?.id ? String(cancelled.rows[0].id) : null;
      repairJobId = cancelled.rows[0]?.last_repair_job_id
        ? String(cancelled.rows[0].last_repair_job_id)
        : null;
      if (planId) {
        await tx.query(
          `update autopilot_repair_operations
              set status = 'failed', terminal_outcome = 'cancelled',
                  diagnostic = '{"code":"cancelled"}'::jsonb,
                  completed_at = now(), updated_at = now()
            where plan_id = $1 and project_id = $2 and channel_id = $3
              and status in ('queued', 'processing')`,
          [planId, projectId, channelId],
        );
      }
      await tx.query("commit");
    } catch (error) {
      await tx.query("rollback").catch(() => {});
      throw error;
    } finally {
      tx.release();
    }

    if (planId) {
      try {
        const queue = getAutopilotQueue();
        const jobIds = [
          `autopilot-plan-${planId}`,
          ...(repairJobId ? [`autopilot-repair-${projectId}-${repairJobId}`] : []),
        ];
        for (const jobId of jobIds) {
          const job = await queue.getJob(jobId);
          await job?.remove();
        }
      } catch (error) {
        // The DB status is the authority. An active worker will fail its next guarded
        // checkpoint/finalization even if BullMQ cannot remove the locked job immediately.
        console.warn("[/api/autopilot/generate] cancel queue", {
          planId,
          errorName: error instanceof Error ? error.name : "Error",
        });
      }
    }
    return NextResponse.json({ ok: true, cancelled: Boolean(planId), planId });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/autopilot/generate] DELETE", error);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
