import { withProjectRoute } from "@/lib/project-route";
import { NextRequest, NextResponse } from "next/server";
import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { DRAFT_REVIEW_POLICY_VERSION } from "@/lib/draft-review";
import { sanitizeAutopilotPublicText } from "@/lib/autopilot-publication.mjs";
import { enqueueAutopilotPost, resolveChannel } from "@/lib/autopilot";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { ProjectAccessError, requireProjectPermission, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";
import { localScheduleFieldsForInstant } from "@/lib/timezone-schedule";
import { assessAutopilotDraft } from "@/lib/autopilot-quality.mjs";
import { normalizePostQuality, type QualityResult } from "@/lib/post-quality.mjs";
import { evaluateAutopilotItem } from "@/lib/autopilot-approval.mjs";
import { autopilotEditorContent, autopilotEditorPostHash, persistAutopilotEditorPayload } from "@/lib/autopilot-editor-payload.mjs";
import { recordDraftRevisionInTransaction } from "@/lib/editorial-approval";
import type { Post } from "@/lib/types";
import type { RichTextEntity } from "@/lib/rich-text.mjs";

export const runtime = "nodejs";

type PlanItem = {
  i: number; draft: string; topic?: string; scheduledAt: string; status: string;
  draftId?: number; postId?: number; editorVersion?: number; editorPostHash?: string;
  sources?: { id: string | number; text: string }[]; quality?: QualityResult;
  qualityBlocked?: boolean; qualityOrigin?: string; aiReady?: boolean;
  reviewRequired?: boolean; reviewState?: string; invented?: string[];
  approvalBlockers?: unknown; humanAttestation?: unknown;
  media?: Post["media"]; formatting?: RichTextEntity[]; scheduleTimezone?: string;
};
type Plan = { id: string; channel_id: string; revision: string; items: PlanItem[] };
type Draft = {
  id: string; version: string; text: string; media: Post["media"];
  formatting: RichTextEntity[]; scheduled_at: Date | string | null; scheduled_timezone: string | null;
};
type ScheduledPost = { id: string; text: string; media: Post["media"]; scheduled_at: Date | string; status: string; schedule_revision: string; publication_operation_id: string | null };
const validId = (v: unknown) => Number.isSafeInteger(Number(v)) && Number(v) > 0;
const failure = (error: string, status = 409) => NextResponse.json({ ok: false, error }, { status });

/** Opening an editor only creates a private, linked draft; it never schedules a post. */
async function handlePOST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) return failure("forbidden", 403);
  const user = await getSessionUser(req);
  if (!user) return failure("unauthorized", 401);
  let body: Record<string, unknown>;
  try { body = await readJsonBodyValue(req); } catch { return failure("bad_request", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return failure("bad_request", 400);
  const postId = validId(body.postId) ? Number(body.postId) : null;
  const planId = Number(body.planId);
  const index = Number(body.index);
  const planRevision = Number(body.planRevision);
  if (!postId && (!validId(planId) || !validId(planRevision) || !Number.isSafeInteger(index) || index < 0)) return failure("bad_request", 422);
  const pool = getPool();
  try {
    const { projectId } = await requireSelectedProjectPermission(pool, user.id, "content.edit");
    const channelId = await resolveChannel({ actorUserId: user.id, projectId }, Number(body.channelId) || null);
    if (!channelId) return failure("no_channel", 422);
    const tx = await pool.connect();
    try {
      await tx.query("begin");
      await requireProjectPermission(tx, user.id, projectId, "content.edit", { lock: true });
      const plan = (await tx.query<Plan>(
        postId
          ? `select id, items, channel_id, revision from autopilot_plan where project_id = $1 and channel_id = $2
               and status in ('pending', 'approved') and exists (
                 select 1 from jsonb_array_elements(items) item where item->>'postId' = $3::text
               ) order by id desc limit 1 for update`
          : `select id, items, channel_id, revision from autopilot_plan where project_id = $1 and channel_id = $2
               and id = $3 and revision = $4 and status in ('pending', 'approved') for update`,
        postId ? [projectId, channelId, postId] : [projectId, channelId, planId, planRevision],
      )).rows[0];
      if (!plan) { await tx.query("rollback"); return failure("stale_plan"); }
      const item = plan.items.find((entry) => postId ? Number(entry.postId) === postId : entry.i === index);
      if (!item || !["pending", "expired", "approved"].includes(item.status)) { await tx.query("rollback"); return failure("item_unavailable"); }
      let post: ScheduledPost | undefined;
      if (item.postId) {
        await requireProjectPermission(tx, user.id, projectId, "content.publish");
        post = (await tx.query<ScheduledPost>(
          `select id, text, media, scheduled_at, status, schedule_revision, publication_operation_id
             from posts where id = $1 and project_id = $2 and channel_id = $3 for update`,
          [item.postId, projectId, channelId],
        )).rows[0];
        if (!post || post.status !== "scheduled" || post.publication_operation_id) { await tx.query("rollback"); return failure("item_unavailable"); }
      }
      let draft: Draft | undefined;
      if (item.draftId) {
        draft = (await tx.query<Draft>(`select id, version, text, media, formatting, scheduled_at, scheduled_timezone from drafts where id = $1 and project_id = $2 for update`, [item.draftId, projectId])).rows[0];
      }
      const text = post?.text ?? (item.editorVersion ? item.draft : sanitizeAutopilotPublicText(item.draft));
      const scheduledAt = post ? new Date(post.scheduled_at).toISOString() : item.scheduledAt;
      const schedule = localScheduleFieldsForInstant(scheduledAt, item.scheduleTimezone ?? "Europe/Moscow");
      if (!draft) {
        const content = autopilotEditorContent(text, item.formatting);
        const created = await tx.query<Draft>(
          `insert into drafts (user_id, project_id, text, media, tracking, scheduled_at, origin, purpose,
             client_key, review_policy_version, scheduled_timezone, scheduled_local_date, scheduled_local_time,
             scheduled_offset, scheduled_disambiguation, formatting)
           values ($1, $2, $3, $4::jsonb, '{}'::jsonb, $5, 'autopilot', 'publishable', $6, $7, $8, $9::date, $10::time, $11, 'reject', $12::jsonb)
           returning id, version, text, media, formatting, scheduled_at, scheduled_timezone`,
          [user.id, projectId, content.text, JSON.stringify(post?.media ?? item.media ?? null), scheduledAt,
            `autopilot-item:${projectId}:${plan.id}:${item.i}`, DRAFT_REVIEW_POLICY_VERSION,
            schedule.timezone, schedule.localDate, schedule.localTime, schedule.offset, JSON.stringify(content.formatting)],
        );
        draft = created.rows[0];
        await tx.query(`insert into draft_destinations (draft_id, channel_id) values ($1, $2) on conflict do nothing`, [draft.id, channelId]);
        await recordDraftRevisionInTransaction(tx, { draftId: Number(draft.id), actorUserId: user.id, projectId });
        item.draftId = Number(draft.id);
        if (post) item.editorPostHash = autopilotEditorPostHash(post);
      } else if (post && item.editorVersion === Number(draft.version)) {
        // Refresh only a clean editor draft. Unsynced work retains its original conflict fence.
        const content = autopilotEditorContent(post.text, post.text === draft.text ? draft.formatting : undefined);
        await tx.query(`update drafts set text = $3, media = $4::jsonb, scheduled_at = $5,
          scheduled_timezone = $6, scheduled_local_date = $7::date, scheduled_local_time = $8::time,
          scheduled_offset = $9, formatting = $10::jsonb, version = version + 1,
          human_reviewed_version = null, human_reviewed_at = null, updated_at = now()
          where id = $1 and project_id = $2`,
          [draft.id, projectId, content.text, JSON.stringify(post.media), scheduledAt, schedule.timezone, schedule.localDate, schedule.localTime, schedule.offset,
            JSON.stringify(content.formatting)]);
        await recordDraftRevisionInTransaction(tx, { draftId: Number(draft.id), actorUserId: user.id, projectId });
        item.editorPostHash = autopilotEditorPostHash(post);
      }
      delete item.editorVersion;
      const saved = await tx.query<{ revision: string }>(`update autopilot_plan set items = $3::jsonb, revision = revision + 1 where id = $1 and project_id = $2 returning revision`, [plan.id, projectId, JSON.stringify(plan.items)]);
      await tx.query("commit");
      return NextResponse.json({ ok: true, draftId: Number(draft.id), revision: Number(saved.rows[0].revision), planId: Number(plan.id), index: item.i, postId: item.postId ?? null });
    } catch (error) { await tx.query("rollback").catch(() => undefined); throw error; }
    finally { tx.release(); }
  } catch (error) {
    if (error instanceof ProjectAccessError) return failure("access_denied", 403);
    console.error("[/api/autopilot/item/draft POST]", error);
    return failure("server", 500);
  }
}

/** Saves one acknowledged editor version back to its plan, preserving post identity. */
async function handlePATCH(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) return failure("forbidden", 403);
  const user = await getSessionUser(req);
  if (!user) return failure("unauthorized", 401);
  let body: Record<string, unknown>;
  try { body = await readJsonBodyValue(req); } catch { return failure("bad_request", 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return failure("bad_request", 400);
  if (!validId(body.draftId) || !validId(body.draftVersion)) return failure("bad_request", 422);
  const pool = getPool();
  try {
    const { projectId } = await requireSelectedProjectPermission(pool, user.id, "content.edit");
    const plan = (await pool.query<Plan>(`select id, channel_id, revision, items from autopilot_plan
      where project_id = $1 and status in ('pending', 'approved') and exists (
        select 1 from jsonb_array_elements(items) item where item->>'draftId' = $2::text
      ) order by id desc limit 1`, [projectId, body.draftId])).rows[0];
    const item = plan?.items.find((entry) => Number(entry.draftId) === Number(body.draftId));
    if (!item || !["pending", "expired", "approved"].includes(item.status)) return failure("item_unavailable");
    if (item.postId) await requireProjectPermission(pool, user.id, projectId, "content.publish");
    const draft = (await pool.query<Draft>(`select id, version, text, media, formatting, scheduled_at, scheduled_timezone from drafts where id = $1 and project_id = $2`, [body.draftId, projectId])).rows[0];
    if (!draft || Number(draft.version) !== Number(body.draftVersion)) return failure("version_conflict");
    if (!draft.text.trim()) return failure("empty_draft", 422);
    if (!draft.scheduled_at || !Number.isFinite(new Date(draft.scheduled_at).getTime()) || new Date(draft.scheduled_at).getTime() < Date.now() + 60_000) return failure("invalid_schedule", 422);
    const qualitySettings = (await pool.query<{ quality: unknown }>(`select quality from content_brief where project_id = $1 and channel_id = $2 order by updated_at desc limit 1`, [projectId, plan.channel_id])).rows[0];
    const quality = draft.text === item.draft && item.quality ? item.quality : await assessAutopilotDraft({ text: draft.text, quality: normalizePostQuality(qualitySettings?.quality), topic: item.topic, sources: item.sources ?? [], trigger: "edit_recheck" });
    const nextItem: PlanItem = { ...item, draft: draft.text, media: draft.media, formatting: draft.formatting,
      scheduledAt: new Date(draft.scheduled_at).toISOString(), scheduleTimezone: draft.scheduled_timezone ?? "Europe/Moscow",
      editorVersion: Number(draft.version), quality,
      qualityBlocked: !quality.passed || ["blocked", "confirmation_required"].includes(quality.publicationDisposition ?? ""), qualityOrigin: "automatic",
      aiReady: Boolean(draft.text.trim()),
      reviewRequired: !quality.passed || quality.publicationDisposition === "confirmation_required" || quality.semantic?.requiresReview === true,
      reviewState: !quality.passed || quality.publicationDisposition === "blocked" ? "quality_review" : quality.semantic?.status === "not_checked" ? "semantic_only_review" : quality.publicationDisposition === "confirmation_required" ? "editorial_review" : undefined };
    delete nextItem.approvalBlockers;
    delete nextItem.humanAttestation;
    delete nextItem.invented;
    if (!nextItem.postId) nextItem.status = "pending";
    // Already queued content must pass the same human-review quality boundary before replacement.
    if (nextItem.postId && !evaluateAutopilotItem({ ...nextItem, status: "pending", postId: undefined } as Parameters<typeof evaluateAutopilotItem>[0], Date.now(), { actor: "human" }).eligible) return failure("quality_failed", 422);
    const tx = await pool.connect();
    let scheduleRevision = 0;
    try {
      await tx.query("begin");
      await requireProjectPermission(tx, user.id, projectId, "content.edit", { lock: true });
      if (item.postId) await requireProjectPermission(tx, user.id, projectId, "content.publish", { lock: true });
      const locked = (await tx.query<Plan>(`select id, items, channel_id, revision from autopilot_plan where id = $1 and project_id = $2 and revision = $3 and status in ('pending', 'approved') for update`, [plan.id, projectId, plan.revision])).rows[0];
      if (!locked) { await tx.query("rollback"); return failure("stale_plan"); }
      const currentDraft = (await tx.query<{ version: string; channel_ids: string[] }>(`select d.version, array(select channel_id from draft_destinations where draft_id = d.id) as channel_ids from drafts d where id = $1 and project_id = $2 for update`, [draft.id, projectId])).rows[0];
      if (!currentDraft || Number(currentDraft.version) !== Number(draft.version)) { await tx.query("rollback"); return failure("version_conflict"); }
      const existingPublication = await tx.query(
        `select p.id from posts p join publication_operations operation on operation.id = p.publication_operation_id
             where p.project_id = $1 and operation.project_id = $1 and operation.draft_id = $2
           and p.status <> 'cancelled' and ($3::bigint is null or p.id <> $3) limit 1`,
        [projectId, draft.id, item.postId ?? null],
      );
      if (existingPublication.rows[0]) { await tx.query("rollback"); return failure("post_changed"); }
      if (currentDraft.channel_ids.length !== 1 || Number(currentDraft.channel_ids[0]) !== Number(plan.channel_id)) { await tx.query("rollback"); return failure("channel_changed", 422); }
      if (item.postId) {
        const post = (await tx.query<ScheduledPost>(`select id, text, media, scheduled_at, status, schedule_revision, publication_operation_id from posts where id = $1 and project_id = $2 and channel_id = $3 for update`, [item.postId, projectId, plan.channel_id])).rows[0];
        if (!post || post.status !== "scheduled" || post.publication_operation_id || autopilotEditorPostHash(post) !== item.editorPostHash) { await tx.query("rollback"); return failure("post_changed"); }
        const started = await tx.query(`select id from publication_parts where post_id = $1 and (external_message_id is not null or send_status not in ('pending', 'failed')) limit 1`, [item.postId]);
        if (started.rowCount) { await tx.query("rollback"); return failure("publication_in_progress"); }
        const updated = (await tx.query<ScheduledPost>(`update posts set text = $4, media = $5::jsonb, scheduled_at = $6,
          scheduled_timezone = $7, publication_draft_version = $8, schedule_revision = schedule_revision + 1 where id = $1 and project_id = $2 and channel_id = $3 and status = 'scheduled'
          returning id, text, media, scheduled_at, schedule_revision`, [item.postId, projectId, plan.channel_id, nextItem.draft, JSON.stringify(nextItem.media), nextItem.scheduledAt, nextItem.scheduleTimezone, nextItem.editorVersion])).rows[0];
        scheduleRevision = Number(updated.schedule_revision);
        nextItem.editorPostHash = autopilotEditorPostHash(updated);
        await tx.query(`delete from publication_parts where post_id = $1`, [item.postId]);
        await persistAutopilotEditorPayload(tx, item.postId, nextItem);
        await tx.query(`update autopilot_schedule_outbox set scheduled_at = $3, status = 'pending', updated_at = now() where post_id = $1 and project_id = $2`, [item.postId, projectId, nextItem.scheduledAt]);
      }
      const items = locked.items.map((entry) => entry.i === item.i ? nextItem : entry);
      const saved = await tx.query<{ revision: string }>(`update autopilot_plan set items = $3::jsonb, edited = true, revision = revision + 1 where id = $1 and project_id = $2 returning revision`, [plan.id, projectId, JSON.stringify(items)]);
      await tx.query("commit");
      let queuePending = false;
      if (item.postId) {
        try { await enqueueAutopilotPost(projectId, item.postId, nextItem.scheduledAt, scheduleRevision); }
        catch { queuePending = true; }
      }
      return NextResponse.json({ ok: true, revision: Number(saved.rows[0].revision), planId: Number(plan.id), index: item.i, channelId: Number(plan.channel_id), postId: item.postId ?? null, queuePending });
    } catch (error) { await tx.query("rollback").catch(() => undefined); throw error; }
    finally { tx.release(); }
  } catch (error) {
    if (error instanceof ProjectAccessError) return failure("access_denied", 403);
    console.error("[/api/autopilot/item/draft PATCH]", error);
    return failure("server", 500);
  }
}

export const POST = withProjectRoute(handlePOST);

export const PATCH = withProjectRoute(handlePATCH);
