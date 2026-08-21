import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { DRAFT_REVIEW_POLICY_VERSION } from "@/lib/draft-review";
import { sanitizeAutopilotPublicText } from "@/lib/autopilot-publication.mjs";
import { resolveChannel } from "@/lib/autopilot";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";
import { localScheduleFieldsForInstant } from "@/lib/timezone-schedule";

export const runtime = "nodejs";

type PlanItem = {
  i: number;
  draft: string;
  scheduledAt: string;
  status: string;
  draftId?: number;
};

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const planId = Number(body.planId);
  const planRevision = Number(body.planRevision);
  const index = Number(body.index);
  if (
    !Number.isSafeInteger(planId) || planId <= 0 ||
    !Number.isSafeInteger(planRevision) || planRevision <= 0 ||
    !Number.isSafeInteger(index) || index < 0
  ) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 422 });
  }

  const pool = getPool();
  try {
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.edit");
    const projectId = membership.projectId;
    const channelId = await resolveChannel(
      { actorUserId: user.id, projectId },
      Number(body.channelId) || null,
    );
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const tx = await pool.connect();
    try {
      await tx.query("begin");
      const plan = (
        await tx.query<{ items: PlanItem[] }>(
          `select items from autopilot_plan
            where id = $1 and project_id = $2 and channel_id = $3
              and revision = $4 and status in ('pending', 'approved')
            for update`,
          [planId, projectId, channelId, planRevision],
        )
      ).rows[0];
      if (!plan) {
        await tx.query("rollback");
        return NextResponse.json({ ok: false, error: "stale_plan" }, { status: 409 });
      }
      const item = plan.items.find((entry) => Number(entry.i) === index);
      if (!item) {
        await tx.query("rollback");
        return NextResponse.json({ ok: false, error: "no_item" }, { status: 404 });
      }
      if (item.status !== "pending" || item.draftId) {
        if (item.draftId) {
          const linked = await tx.query(
            `select id from drafts where id = $1 and project_id = $2`,
            [item.draftId, projectId],
          );
          if (linked.rowCount) {
            await tx.query("commit");
            return NextResponse.json({
              ok: true,
              draftId: Number(item.draftId),
              revision: planRevision,
              created: false,
            });
          }
        }
        await tx.query("rollback");
        return NextResponse.json({ ok: false, error: "item_unavailable" }, { status: 409 });
      }

      const text = sanitizeAutopilotPublicText(item.draft);
      if (!text) {
        await tx.query("rollback");
        return NextResponse.json({ ok: false, error: "empty_draft" }, { status: 422 });
      }
      const schedule = localScheduleFieldsForInstant(item.scheduledAt, "Europe/Moscow");
      const clientKey = `autopilot-item:${projectId}:${planId}:${index}`;
      const inserted = await tx.query<{ id: string }>(
        `insert into drafts (
           user_id, project_id, text, media, tracking, scheduled_at, origin, purpose,
           source_ref, client_key, review_policy_version, ai_validation,
           scheduled_timezone, scheduled_local_date, scheduled_local_time,
           scheduled_offset, scheduled_disambiguation, formatting
         ) values (
           $1, $2, $3, null, '{}'::jsonb, $4, 'autopilot', 'publishable',
           null, $5, $6, null, $7, $8::date, $9::time, $10, 'reject', '[]'::jsonb
         )
         on conflict (user_id, client_key) do nothing
         returning id`,
        [
          user.id,
          projectId,
          text,
          item.scheduledAt,
          clientKey,
          DRAFT_REVIEW_POLICY_VERSION,
          schedule.timezone,
          schedule.localDate,
          schedule.localTime,
          schedule.offset,
        ],
      );
      let draftId = inserted.rows[0] ? Number(inserted.rows[0].id) : null;
      if (!draftId) {
        const existing = (
          await tx.query<{ id: string }>(
            `select id from drafts where project_id = $1 and user_id = $2 and client_key = $3`,
            [projectId, user.id, clientKey],
          )
        ).rows[0];
        draftId = existing ? Number(existing.id) : null;
      }
      if (!draftId) throw new Error("autopilot draft lookup failed");
      await tx.query(
        `insert into draft_destinations (draft_id, channel_id)
         values ($1, $2) on conflict (draft_id, channel_id) do nothing`,
        [draftId, channelId],
      );

      item.draft = text;
      item.draftId = draftId;
      const saved = await tx.query<{ revision: string }>(
        `update autopilot_plan
            set items = $5::jsonb, revision = revision + 1
          where id = $1 and project_id = $2 and channel_id = $3 and revision = $4
          returning revision`,
        [planId, projectId, channelId, planRevision, JSON.stringify(plan.items)],
      );
      if (!saved.rows[0]) {
        await tx.query("rollback");
        return NextResponse.json({ ok: false, error: "stale_plan" }, { status: 409 });
      }
      await tx.query("commit");
      return NextResponse.json(
        {
          ok: true,
          draftId,
          revision: Number(saved.rows[0].revision),
          created: inserted.rowCount === 1,
        },
        { status: inserted.rowCount === 1 ? 201 : 200 },
      );
    } catch (error) {
      await tx.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      tx.release();
    }
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/autopilot/item/draft]", error);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
