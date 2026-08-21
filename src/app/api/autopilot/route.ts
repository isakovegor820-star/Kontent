// Д.9 — состояние автопилота ДЛЯ ВЫБРАННОГО КАНАЛА: настройки + последний план + бриф.
//
// Раньше всё это было на пользователе: одни настройки, один бриф, план без канала. При двух
// каналах автопилот молча писал в один из них по брифу другого, а второй не получал ничего.
// Теперь у каждого канала своё, а страница спрашивает состояние конкретного канала.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { ensureSettings, loadBrief, resolveChannel } from "@/lib/autopilot";
import { briefComplete } from "@/lib/brief";
import { isAutopilotBuildStale } from "@/lib/autopilot-build";
import {
  autopilotBuildActivityAt,
} from "@/lib/autopilot-build-progress.mjs";
import { plannedPostCountForWeeks } from "@/lib/autopilot-config.mjs";
import { isAutopilotHumanReviewItem } from "@/lib/autopilot-approval.mjs";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { sanitizeAutopilotPublicText } from "@/lib/autopilot-publication.mjs";
import { normalizeAutopilotQuickSettings } from "@/lib/autopilot-style.mjs";
import {
  autopilotBuildAttemptDto,
  serializeAutopilotActivePlan,
} from "@/lib/autopilot-build-attempt.mjs";

export const runtime = "nodejs";

const empty = {
  settings: null,
  plan: null,
  activePlan: null,
  buildAttempt: null,
  hasChannel: false,
  brief: null,
  channels: [],
  channelId: null,
};

function errorReasonForPlan(plan: Record<string, unknown> | null) {
  if (!plan || plan.status !== "error") return null;
  const reasons: Record<string, string> = {
    ai_usage_limit: "quota",
    content_variety_insufficient: "variety",
    quality_gate_unsatisfied: "quality",
    no_sources_found: "sources",
    ai_unavailable: "provider",
    cancelled: "cancelled",
    timeout: "timeout",
  };
  return reasons[String(plan.rules || "")] || "provider";
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json(empty);

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    const scope = { actorUserId: user.id, projectId: membership.projectId };

    // Список каналов нужен странице всегда: без него не нарисовать выбор.
    const channels = (
      await pool.query<{ id: string; title: string | null; handle: string | null }>(
        `select id, title, handle from channels
          where project_id = $1 and network = 'tg' and is_active = true order by id`,
        [membership.projectId],
      )
    ).rows.map((c) => ({ ...c, id: Number(c.id) })); // bigint приезжает строкой — см. resolveChannel
    if (!channels.length) return NextResponse.json({ ...empty, channels: [] });

    const wanted = Number(req.nextUrl.searchParams.get("channel")) || null;
    const channelId = await resolveChannel(scope, wanted);
    // Попросили чужой или отключённый канал — честная 404, а не тихая подмена на свой.
    if (!channelId) return NextResponse.json({ ...empty, channels }, { status: wanted ? 404 : 200 });

    const settings = await ensureSettings(scope, channelId);
    const plans = (
        await pool.query(
          `with scoped as (
             select id, week_start, items, rules, status, revision, created_at,
                    build_activity_at,
                    generation_engine, generation_post_frequency, expected_post_count,
                    publication_target_count, candidate_count,
                    planning_months, planning_weeks, quick_settings, build_report,
                    repair_strategy, terminal_outcome, repair_attempt, ai_call_count,
                    row_number() over (
                      partition by case
                        when status in ('pending', 'approved', 'approving') then 'active'
                        else 'attempt'
                      end
                      order by created_at desc, id desc
                    ) as lifecycle_rank
               from autopilot_plan
              where project_id = $1 and channel_id = $2
                and status in ('pending', 'approved', 'approving', 'building', 'partial', 'error')
           )
           select * from scoped where lifecycle_rank = 1`,
          [membership.projectId, channelId],
        )
      ).rows;
    let activeRow = plans.find((candidate) =>
      ["pending", "approved", "approving"].includes(String(candidate.status)),
    ) ?? null;
    let attemptRow = plans.find((candidate) =>
      ["building", "partial", "error"].includes(String(candidate.status)),
    ) ?? null;
    const expectedPostCount = attemptRow
      ? Number(attemptRow.candidate_count || attemptRow.expected_post_count) || plannedPostCountForWeeks(
          attemptRow.generation_post_frequency || settings.post_frequency || 5,
          attemptRow.planning_weeks ?? attemptRow.planning_months * 4,
        )
      : 0;

    // A queue job can survive while its worker is stopped. Without a deadline that left the
    // page polling `building` forever (the real incident lasted two days). Mark only the exact
    // placeholder we loaded, so a concurrent retry for the same channel cannot be touched.
    if (
      attemptRow?.status === "building" &&
      isAutopilotBuildStale(
        attemptRow.build_activity_at || autopilotBuildActivityAt(attemptRow.created_at, attemptRow.items),
        expectedPostCount,
      )
    ) {
      const expired = await pool.query(
        `update autopilot_plan
            set status = 'error', rules = 'timeout', terminal_outcome = 'provider_error',
                revision = revision + 1
          where id = $1 and project_id = $2 and channel_id = $3 and status = 'building'
          returning id`,
        [attemptRow.id, membership.projectId, channelId],
      );
      if (expired.rowCount) {
        await pool.query(
          `update autopilot_repair_operations
              set status = 'failed', terminal_outcome = 'provider_error',
                  diagnostic = '{"code":"timeout"}'::jsonb,
                  completed_at = now(), updated_at = now()
            where plan_id = $1 and project_id = $2 and channel_id = $3
              and status in ('queued', 'processing')`,
          [attemptRow.id, membership.projectId, channelId],
        );
        attemptRow = { ...attemptRow, status: "error", rules: "timeout", errorReason: "timeout" };
      }
    }
    const brief = await loadBrief(scope, channelId);
    if (Array.isArray(activeRow?.items)) {
      const draftIds = activeRow.items
        .map((item: { draftId?: unknown }) => Number(item.draftId))
        .filter((id: number) => Number.isSafeInteger(id) && id > 0);
      const linkedDrafts = draftIds.length
        ? (
            await pool.query<{ id: string; text: string; scheduled_at: string | null }>(
              `select id, text, scheduled_at from drafts
                where project_id = $1 and id = any($2::bigint[])`,
              [membership.projectId, draftIds],
            )
          ).rows
        : [];
      const draftById = new Map(linkedDrafts.map((draft) => [Number(draft.id), draft]));
      activeRow = {
        ...activeRow,
        quick_settings: normalizeAutopilotQuickSettings(activeRow.quick_settings),
        items: activeRow.items.map((item: {
          draftId?: unknown;
          draft?: unknown;
          scheduledAt?: string;
          reviewRequired?: boolean;
        }) => {
          const linked = draftById.get(Number(item.draftId));
          const hydrated = {
            ...item,
            draft: sanitizeAutopilotPublicText(linked?.text ?? item.draft),
            ...(linked?.scheduled_at ? { scheduledAt: new Date(linked.scheduled_at).toISOString() } : {}),
          };
          return isAutopilotHumanReviewItem(hydrated)
            ? { ...hydrated, reviewRequired: true }
            : hydrated;
        }),
      };
    }

    if (attemptRow) {
      attemptRow = { ...attemptRow, errorReason: errorReasonForPlan(attemptRow) };
    }
    const activePlan = serializeAutopilotActivePlan(activeRow);
    const buildAttempt = autopilotBuildAttemptDto(attemptRow, expectedPostCount);
    const legacyPlan = activePlan
      ? {
          ...activePlan,
          generation_engine: activePlan.generationEngine,
          planning_months: activePlan.planningMonths,
          planning_weeks: activePlan.planningWeeks,
          expected_post_count: activePlan.expectedPostCount,
          quick_settings: activePlan.quickSettings,
        }
      : null;
    const publicSettings = {
      enabled: settings.enabled,
      mode: settings.mode,
      post_frequency: settings.post_frequency,
      approvals_streak: settings.approvals_streak,
      generation_engine: settings.generation_engine,
      planning_months: settings.planning_months,
      planning_weeks: settings.planning_weeks,
      quick_settings: normalizeAutopilotQuickSettings(settings.quick_settings),
    };

    return NextResponse.json({
      settings: publicSettings,
      activePlan,
      buildAttempt,
      // Backward compatibility: `plan` is always the usable publication result. A failed
      // or partial attempt never masks it.
      plan: legacyPlan,
      hasChannel: true,
      brief,
      briefReady: brief.ready && briefComplete(brief),
      channels,
      channelId,
    });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ...empty, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/autopilot]", err);
    return NextResponse.json({ ...empty, error: "server" }, { status: 500 });
  }
}
