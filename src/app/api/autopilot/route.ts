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
  autopilotBuildProgress,
} from "@/lib/autopilot-build-progress.mjs";
import { plannedPostCountForWeeks } from "@/lib/autopilot-config.mjs";
import { isAutopilotHumanReviewItem } from "@/lib/autopilot-approval.mjs";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";

export const runtime = "nodejs";

const empty = { settings: null, plan: null, hasChannel: false, brief: null, channels: [], channelId: null };

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
    let plan =
      (
        await pool.query(
          `select id, week_start, items, rules, status, revision, created_at,
                  build_activity_at,
                  generation_engine, generation_post_frequency, expected_post_count,
                  planning_months, planning_weeks
             from autopilot_plan where project_id = $1 and channel_id = $2
             order by created_at desc limit 1`,
          [membership.projectId, channelId],
        )
      ).rows[0] ?? null;
    if (plan?.status === "error" && plan.rules === "ai_usage_limit") {
      plan = { ...plan, errorReason: "quota" };
    }
    if (plan?.status === "error" && plan.rules === "content_variety_insufficient") {
      plan = { ...plan, errorReason: "variety" };
    }
    if (plan?.status === "error" && plan.rules === "quality_gate_unsatisfied") {
      plan = { ...plan, errorReason: "quality" };
    }
    if (plan?.status === "error" && plan.rules === "ai_unavailable") {
      plan = { ...plan, errorReason: "provider" };
    }
    if (plan?.status === "error" && plan.rules === "cancelled") {
      plan = { ...plan, errorReason: "cancelled" };
    }
    const expectedPostCount = plan
      ? Number(plan.expected_post_count) || plannedPostCountForWeeks(
          settings.post_frequency,
          plan.planning_weeks ?? plan.planning_months * 4,
        )
      : 0;
    if (plan?.status === "building") {
      plan = {
        ...plan,
        buildProgress: autopilotBuildProgress(plan.items, expectedPostCount),
      };
    }

    // A queue job can survive while its worker is stopped. Without a deadline that left the
    // page polling `building` forever (the real incident lasted two days). Mark only the exact
    // placeholder we loaded, so a concurrent retry for the same channel cannot be touched.
    if (
      plan?.status === "building" &&
      isAutopilotBuildStale(
        plan.build_activity_at || autopilotBuildActivityAt(plan.created_at, plan.items),
        expectedPostCount,
      )
    ) {
      const expired = await pool.query(
        `update autopilot_plan set status = 'error', revision = revision + 1
          where id = $1 and project_id = $2 and channel_id = $3 and status = 'building'
          returning id`,
        [plan.id, membership.projectId, channelId],
      );
      if (expired.rowCount) plan = { ...plan, status: "error", errorReason: "timeout" };
    }
    const brief = await loadBrief(scope, channelId);
    if (Array.isArray(plan?.items)) {
      plan = {
        ...plan,
        items: plan.items.map((item: { reviewRequired?: boolean }) =>
          isAutopilotHumanReviewItem(item) ? { ...item, reviewRequired: true } : item,
        ),
      };
    }

    return NextResponse.json({
      settings,
      plan,
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
