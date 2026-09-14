import { NextRequest, NextResponse } from "next/server";
import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission, requireProjectPermission } from "@/lib/project-permissions";
import { resolveLocalSchedule, ScheduleValidationError } from "@/lib/timezone-schedule";
import { enqueueAutopilotPost } from "@/lib/autopilot";
import { recordDraftRevisionInTransaction } from "@/lib/editorial-approval";

export const runtime = "nodejs";
const errorResponse = (error: string, status = 409) => NextResponse.json({ ok: false, error }, { status });
type Item = { i: number; scheduledAt: string; scheduleTimezone?: string; status: string; postId?: number; draftId?: number; editorVersion?: number; approvalBlockers?: unknown };

export async function PATCH(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) return errorResponse("forbidden", 403);
  const user = await getSessionUser(req);
  if (!user) return errorResponse("unauthorized", 401);
  let body: Record<string, unknown>;
  try { body = await readJsonBodyValue(req); } catch { return errorResponse("bad_request", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse("bad_request", 400);
  const postId = Number(body.postId) || null;
  const planId = Number(body.planId);
  const revision = Number(body.planRevision);
  const index = Number(body.index);
  if (postId != null ? !Number.isSafeInteger(postId) || postId < 1 || !Number.isSafeInteger(Number(body.scheduleRevision)) : !Number.isSafeInteger(planId) || planId < 1 || !Number.isSafeInteger(revision) || revision < 1 || !Number.isSafeInteger(index) || index < 0) return errorResponse("bad_request", 422);
  try {
    const schedule = resolveLocalSchedule({ localDate: String(body.localDate ?? ""), localTime: String(body.localTime ?? ""), timezone: "Europe/Moscow", disambiguation: "reject" });
    if (new Date(schedule.scheduledAt).getTime() < Date.now() + 60_000) return errorResponse("past", 422);
    const pool = getPool();
    const { projectId } = await requireSelectedProjectPermission(pool, user.id, "content.edit");
    const tx = await pool.connect();
    let scheduledPostId: number | undefined;
    let nextScheduleRevision = 0;
    try {
      await tx.query("begin");
      const plan = (await tx.query<{ id: string; revision: string; channel_id: string; items: Item[] }>(
        postId
          ? `select id, revision, channel_id, items from autopilot_plan where project_id = $1 and status in ('pending', 'approved') and exists (select 1 from jsonb_array_elements(items) item where item->>'postId' = $2::text) order by id desc limit 1 for update`
          : `select id, revision, channel_id, items from autopilot_plan where project_id = $1 and id = $2 and revision = $3 and status in ('pending', 'approved') for update`,
        postId ? [projectId, postId] : [projectId, planId, revision],
      )).rows[0];
      const item = plan?.items.find((entry) => postId ? Number(entry.postId) === postId : entry.i === index);
      if (!item || !["pending", "expired", "approved"].includes(item.status)) { await tx.query("rollback"); return errorResponse("stale_plan"); }
      if (item.postId) {
        await requireProjectPermission(tx, user.id, projectId, "content.publish");
        const updated = await tx.query<{ schedule_revision: string }>(`update posts set scheduled_at = $4, scheduled_timezone = $5, scheduled_offset = $6,
          schedule_revision = schedule_revision + 1 where id = $1 and project_id = $2 and channel_id = $3 and status = 'scheduled' and publication_operation_id is null
          and ($7::bigint is null or schedule_revision = $7)
          and not exists (select 1 from publication_parts where post_id = posts.id and (external_message_id is not null or send_status not in ('pending', 'failed')))
          returning schedule_revision`, [item.postId, projectId, plan.channel_id, schedule.scheduledAt, schedule.timezone, schedule.offset, postId ? Number(body.scheduleRevision) : null]);
        if (!updated.rows[0]) { await tx.query("rollback"); return errorResponse("post_changed"); }
        scheduledPostId = item.postId;
        nextScheduleRevision = Number(updated.rows[0].schedule_revision);
        await tx.query(`update autopilot_schedule_outbox set scheduled_at = $3, status = 'pending', updated_at = now() where post_id = $1 and project_id = $2`, [item.postId, projectId, schedule.scheduledAt]);
      }
      item.scheduledAt = schedule.scheduledAt;
      item.scheduleTimezone = schedule.timezone;
      if (!item.postId) item.status = "pending";
      delete item.approvalBlockers;
      if (item.draftId) {
        const updated = await tx.query<{ version: string }>(`update drafts set scheduled_at = $3, scheduled_timezone = $4, scheduled_local_date = $5::date,
          scheduled_local_time = $6::time, scheduled_offset = $7, scheduled_disambiguation = 'reject', version = version + 1,
          human_reviewed_version = null, human_reviewed_at = null, updated_at = now() where id = $1 and project_id = $2 returning version`,
          [item.draftId, projectId, schedule.scheduledAt, schedule.timezone, schedule.localDate, schedule.localTime, schedule.offset]);
        if (updated.rows[0]) {
          if (item.editorVersion === Number(updated.rows[0].version) - 1) item.editorVersion = Number(updated.rows[0].version);
          else delete item.editorVersion;
          await recordDraftRevisionInTransaction(tx, { draftId: item.draftId, actorUserId: user.id, projectId });
        }
      }
      const saved = await tx.query<{ revision: string }>(`update autopilot_plan set items = $3::jsonb, edited = true, revision = revision + 1 where id = $1 and project_id = $2 returning revision`, [plan.id, projectId, JSON.stringify(plan.items)]);
      await tx.query("commit");
      let queuePending = false;
      if (scheduledPostId) {
        try { await enqueueAutopilotPost(projectId, scheduledPostId, schedule.scheduledAt, nextScheduleRevision); }
        catch { queuePending = true; }
      }
      return NextResponse.json({ ok: true, revision: Number(saved.rows[0].revision), queuePending });
    } catch (error) { await tx.query("rollback").catch(() => undefined); throw error; }
    finally { tx.release(); }
  } catch (error) {
    if (error instanceof ProjectAccessError) return errorResponse("access_denied", 403);
    if (error instanceof ScheduleValidationError) return errorResponse(error.code, 422);
    console.error("[/api/autopilot/item/schedule]", error);
    return errorResponse("server", 500);
  }
}
