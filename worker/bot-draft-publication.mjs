import { createHash } from "node:crypto";
import { draftRevisionContentHash } from "../src/lib/editorial-revision.mjs";
import { buildTelegramPayload } from "../src/lib/telegram-payload.mjs";
import { reconcilePublicationOutbox } from "../src/lib/publication-outbox.mjs";
import { botQuickSchedule } from "./bot-assistant.mjs";

export class BotPublicationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new BotPublicationError(code); };

// A bot preview contains one plain-text Telegram destination. Rich drafts edited in
// the web app must be previewed there, where media, tracking and extras are visible.
function assertPreview(conversation, revision) {
  const snapshot = revision.snapshot;
  if (Number(conversation.data?.draftVersion) !== Number(conversation.version)
    || Number(revision.draft_version) !== Number(conversation.version)
    || conversation.data?.revisionId !== Number(revision.id)
    || conversation.data?.contentHash !== revision.content_hash
    || draftRevisionContentHash(snapshot) !== revision.content_hash
    || snapshot.text !== conversation.text) fail("preview_changed");
  if (![3, 4].includes(snapshot.schemaVersion)
    || snapshot.origin !== "manual" || snapshot.purpose !== "publishable"
    || snapshot.media != null || Object.keys(snapshot.tracking ?? {}).length !== 0
    || (snapshot.formatting?.length ?? 0) !== 0
    || snapshot.channelIds?.length !== 1
    || Number(snapshot.channelIds[0]) !== Number(conversation.channel_id)
    || (snapshot.publicationPreferences?.selectedBlocks?.length ?? 0) !== 0
    || (snapshot.publicationPreferences?.commentsMode ?? "provider_default") !== "provider_default"
    || snapshot.publicationPreferences?.pinAfterPublish === true
    || snapshot.publicationPreferences?.reviewAt != null) fail("web_preview_required");
  return snapshot;
}

async function authorizeRevision(tx, conversation, workflow, revision, userId, projectId) {
  const isApproved = workflow.state === "approved"
    && Number(workflow.approved_revision_id) === Number(revision.id)
    && workflow.approved_content_hash === revision.content_hash;
  if (isApproved) return;
  if (conversation.role !== "owner" || Number(conversation.personal_owner_user_id) !== userId) {
    fail("approval_required");
  }
  // The personal owner's publication click is the same self-approval decision used
  // by Composer. Persist the exact revision and audit lineage within this transaction.
  let request = (await tx.query(
    `select id from draft_editorial_requests
      where project_id=$1 and draft_id=$2 and revision_id=$3 and status='open' for update`,
    [projectId, conversation.draft_id, revision.id],
  )).rows[0];
  if (!request) request = (await tx.query(
    `insert into draft_editorial_requests(project_id,draft_id,revision_id,content_hash,requested_by_user_id)
     values($1,$2,$3,$4,$5) returning id`,
    [projectId, conversation.draft_id, revision.id, revision.content_hash, userId],
  )).rows[0];
  await tx.query(
    `insert into draft_editorial_decisions(project_id,request_id,draft_id,revision_id,content_hash,actor_user_id,decision)
     values($1,$2,$3,$4,$5,$6,'approve')`,
    [projectId, request.id, conversation.draft_id, revision.id, revision.content_hash, userId],
  );
  await tx.query(
    `update draft_editorial_requests set status='approved',version=version+1,resolved_by_user_id=$2,resolved_at=now()
      where id=$1`, [request.id, userId],
  );
  await tx.query(
    `update draft_editorial_workflows set state='approved',version=version+1,
      submitted_revision_id=$3,submitted_by_user_id=$5,submitted_at=coalesce(submitted_at,now()),
      approved_revision_id=$3,approved_content_hash=$4,updated_at=now()
      where project_id=$1 and draft_id=$2`,
    [projectId, conversation.draft_id, revision.id, revision.content_hash, userId],
  );
  await tx.query(
    `insert into audit_events(project_id,actor_user_id,action,entity_type,entity_id,safe_data,idempotency_key)
     values($1,$2,'draft.approved','draft_revision',$3,$4::jsonb,$5)
     on conflict(project_id,idempotency_key) where idempotency_key is not null do nothing`,
    [projectId,userId,String(revision.id),JSON.stringify({ source: "telegram_bot", decision: "personal_publication", contentHash: revision.content_hash }),`bot:approval:${revision.id}`],
  );
}

/** Persist the exact preview decision, operation, post and outbox in one transaction. */
export async function scheduleBotDraftPublication({ pool, userId, action, token, enqueue }) {
  if (!["now", "hour", "tomorrow"].includes(action)) fail("bad_schedule");
  const tx = await pool.connect();
  let result;
  try {
    await tx.query("begin");
    const scope = (await tx.query(
      `select project_id from bot_conversations where user_id=$1 and token=$2 and expires_at>now()`,
      [userId,token],
    )).rows[0];
    if (!scope) fail("preview_expired");
    const projectId = Number(scope.project_id);
    const member = (await tx.query(
      `select member.role,project.personal_owner_user_id,project.timezone
       from project_members member join projects project on project.id=member.project_id
       where member.project_id=$1 and member.user_id=$2 and member.status='active'
         and member.role in ('owner','publisher') and project.is_archived=false
       for share of member,project`, [projectId,userId],
    )).rows[0];
    if (!member) fail("publication_permission_denied");
    const conversation = (await tx.query(
      `select conversation.id,conversation.channel_id,conversation.draft_id,conversation.state,conversation.data,
              draft.text,draft.version
       from bot_conversations conversation
       join drafts draft on draft.id=conversation.draft_id and draft.project_id=conversation.project_id
       where conversation.user_id=$1 and conversation.token=$2 and conversation.project_id=$3
         and conversation.expires_at>now() for update of conversation,draft`, [userId,token,projectId],
    )).rows[0];
    if (!conversation) fail("preview_expired");
    Object.assign(conversation, member);
    if (conversation.state === "completed" && conversation.data?.postId) {
      await tx.query("commit");
      return { replayed: true, postId: Number(conversation.data.postId), projectId,
        operationId: Number(conversation.data.operationId) || null, queuePending: false,
        scheduledAt: conversation.data.scheduledAt ?? null, timezone: member.timezone };
    }
    if (conversation.state !== "preview") fail("preview_expired");
    const channel = await tx.query(
      `select id from channels where id=$1 and project_id=$2 and network='tg'
       and is_active=true and status='active' for share`, [conversation.channel_id,projectId],
    );
    if (!channel.rowCount) fail("channel_unavailable");
    const workflow = (await tx.query(
      `select current_revision_id,state,approved_revision_id,approved_content_hash
       from draft_editorial_workflows where project_id=$1 and draft_id=$2 for update`,
      [projectId,conversation.draft_id],
    )).rows[0];
    if (!workflow) fail("preview_changed");
    const revision = (await tx.query(
      `select id,draft_version,content_hash,snapshot from draft_revisions
       where id=$1 and project_id=$2 and draft_id=$3 for share`,
      [workflow.current_revision_id,projectId,conversation.draft_id],
    )).rows[0];
    if (!revision) fail("preview_changed");
    const snapshot = assertPreview(conversation, revision);
    await authorizeRevision(tx, conversation, workflow, revision, userId, projectId);
    const schedule = botQuickSchedule(action, String(member.timezone || "UTC"));
    let operation = (await tx.query(
      `select id,scheduled_at,timezone from publication_operations
       where project_id=$1 and draft_id=$2 and approved_revision_id=$3 for update`,
      [projectId,conversation.draft_id,revision.id],
    )).rows[0];
    const replayed = Boolean(operation);
    let postId;
    if (!operation) {
      const options = { fingerprintVersion: 2, source: "telegram_bot", editorialApproval: {
        revisionId: Number(revision.id), draftVersion: Number(revision.draft_version), contentHash: revision.content_hash,
      } };
      const fingerprint = draftRevisionContentHash({ projectId, revisionId: Number(revision.id), contentHash: revision.content_hash, schedule, options });
      operation = (await tx.query(
        `insert into publication_operations(project_id,user_id,draft_id,draft_version,idempotency_key,fingerprint,
         text,media,scheduled_at,timezone,schedule_offset,schedule_disambiguation,destination_ids,options,
         approved_revision_id,approved_draft_version,approved_content_hash,status)
         values($1,$2,$3,$4,$5,$6,$7,null,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$4,$15,'pending')
         returning id,scheduled_at,timezone`,
        [projectId,userId,conversation.draft_id,revision.draft_version,`bot:publication:${conversation.id}:${token}`,
          fingerprint,snapshot.text,schedule.scheduledAt,schedule.timezone,schedule.offset,schedule.disambiguation,
          JSON.stringify(snapshot.channelIds),JSON.stringify(options),revision.id,revision.content_hash],
      )).rows[0];
      const post = (await tx.query(
        `insert into posts(project_id,user_id,channel_id,text,scheduled_at,status,idempotency_key,request_fingerprint,
         publication_origin,publication_operation_id,publication_draft_version,scheduled_timezone,scheduled_offset,scheduled_disambiguation)
         values($1,$2,$3,$4,$5,'scheduled',$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
        [projectId,userId,conversation.channel_id,snapshot.text,schedule.scheduledAt,
          `publication:${operation.id}:destination:${conversation.channel_id}`,`${fingerprint}:${conversation.channel_id}`,
          snapshot.origin,operation.id,revision.draft_version,schedule.timezone,schedule.offset,schedule.disambiguation],
      )).rows[0];
      postId = Number(post.id);
      await tx.query("insert into publication_outbox(operation_id,post_id) values($1,$2)", [operation.id,postId]);
      for (const part of buildTelegramPayload({ text: snapshot.text, entities: [], hasAsset: false }).parts) {
        const payloadHash = createHash("sha256").update(`${part.type}\0${part.payloadHtml || ""}`).digest("hex");
        await tx.query(
          `insert into publication_parts(post_id,part_index,part_type,payload_html,payload_hash,entity_length)
           values($1,$2,$3,$4,$5,$6)`, [postId,part.index,part.type,part.payloadHtml,payloadHash,part.entityLength],
        );
      }
      await tx.query(
        `insert into audit_events(project_id,actor_user_id,action,entity_type,entity_id,after_version,safe_data,idempotency_key)
         values($1,$2,'publication.scheduled_from_bot','publication_operation',$3,1,$4::jsonb,$5)`,
        [projectId,userId,String(operation.id),JSON.stringify({ draftId:Number(conversation.draft_id),draftVersion:Number(revision.draft_version),
          approvedRevisionId:Number(revision.id),approvedContentHash:revision.content_hash,postId,schedule }),`bot:publication:${operation.id}`],
      );
    } else {
      postId = Number((await tx.query(
        "select id from posts where publication_operation_id=$1 and project_id=$2 and channel_id=$3",
        [operation.id,projectId,conversation.channel_id],
      )).rows[0]?.id);
      if (!postId) fail("publication_lineage_missing");
    }
    result = { replayed, postId, projectId, operationId: Number(operation.id),
      scheduledAt: new Date(operation.scheduled_at).toISOString(), timezone: operation.timezone };
    await tx.query(
      `update bot_conversations set state='completed',data=data||$2::jsonb,
       expires_at=now()+interval '24 hours',updated_at=now() where id=$1`,
      [conversation.id,JSON.stringify({ ...result,action })],
    );
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally { tx.release(); }
  // A queue outage never rolls back or deletes accepted user intent. The ordinary
  // publication outbox also recovers after a process crash between commit and dispatch.
  let queuePending = false;
  try {
    const delivery = await reconcilePublicationOutbox({ pool, operationId: result.operationId, enqueue });
    queuePending = delivery.failed > 0;
  } catch { queuePending = true; }
  return { ...result, queuePending };
}
