import { withProjectRoute } from "@/lib/project-route";
// План автопилота для ОСНОВНОГО календаря.
//
// Почему отдельный маршрут, а не /api/posts: элементы плана ещё не публикации. Они не
// имеют строки в posts, не стоят в очереди BullMQ и не будут отправлены без явного
// подтверждения. Отдаём их read-only проекцией, чтобы неделя в календаре не выглядела
// пустой, пока план ждёт проверки.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import {
  ProjectAccessError,
  requireSelectedProjectPermission,
  roleAllows,
} from "@/lib/project-permissions";
import { autopilotPlanCalendarItems, AUTOPILOT_CALENDAR_PLAN_LIMIT } from "@/lib/autopilot-calendar-plan.mjs";

export const runtime = "nodejs";

async function handleGET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    // Один самый свежий живой план на канал — та же семантика, что у страницы автопилота:
    // в окно ранжирования входят и pending, и approving. План в статусе approving нельзя
    // отфильтровать заранее: во время чужого подтверждения он сосуществует с новым планом
    // (worker.mjs не архивирует approving), и тогда rank 1 достался бы устаревшему плану.
    const plans = (
      await pool.query(
        `with active_plan as (
           select plan.id, plan.channel_id, plan.status, plan.revision, plan.items,
                  channel.title as channel_title,
                  row_number() over (
                    partition by plan.channel_id order by plan.created_at desc, plan.id desc
                  ) as rank
             from autopilot_plan plan
             join channels channel
               on channel.id = plan.channel_id and channel.project_id = plan.project_id
            where plan.project_id = $1
              and channel.network = 'tg' and channel.is_active = true
              and plan.status in ('pending', 'approved', 'approving')
         )
         select id, channel_id, status, revision, items, channel_title
           from active_plan
          where rank = 1 and status in ('pending', 'approved')
          order by channel_id`,
        [membership.projectId],
      )
    ).rows;

    // Версии связанных черновиков: снимок плана устаревает, как только человек сохранил
    // правки в Composer. Тогда карточка обязана быть неактивной, а не обещать добавление,
    // которое сервер всё равно отклонит (editor_draft_linked).
    const draftIds = [
      ...new Set(
        plans
          .flatMap((plan) => (Array.isArray(plan.items) ? plan.items : []))
          .map((item) => Number((item as { draftId?: unknown })?.draftId))
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      ),
    ];
    const draftVersions = new Map<number, number>();
    if (draftIds.length) {
      const drafts = await pool.query<{ id: string; version: string }>(
        `select id, version from drafts where project_id = $1 and id = any($2::bigint[])`,
        [membership.projectId, draftIds],
      );
      for (const draft of drafts.rows) {
        draftVersions.set(Number(draft.id), Number(draft.version));
      }
    }

    const projected = autopilotPlanCalendarItems({
      plans,
      canPublish: roleAllows(membership.role, "content.publish"),
      canEdit: roleAllows(membership.role, "content.edit"),
      draftVersions,
      // Просим на один элемент больше: так обрезка видна честно, а не молча.
      limit: AUTOPILOT_CALENDAR_PLAN_LIMIT + 1,
    });
    const truncated = projected.length > AUTOPILOT_CALENDAR_PLAN_LIMIT;
    return NextResponse.json({
      ok: true,
      items: truncated ? projected.slice(0, AUTOPILOT_CALENDAR_PLAN_LIMIT) : projected,
      truncated,
    });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/autopilot/calendar-plan]", {
      errorName: err instanceof Error ? err.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }
}

export const GET = withProjectRoute(handleGET);
