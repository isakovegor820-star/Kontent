function integer(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label}: invalid id`);
  return parsed;
}

export async function listBotApprovalItems(pool, input) {
  const userId = integer(input.userId, "approval user");
  const projectId = integer(input.projectId, "approval project");
  return (
    await pool.query(
      `select request.id as request_id, request.version as request_version,
              workflow.version as workflow_version, request.revision_id,
              request.content_hash, draft.id as draft_id, draft.text,
              coalesce(nullif(btrim(author.name), ''), author.email, 'Автор') as author_name,
              coalesce(nullif(btrim(channel.title), ''), channel.handle, 'Канал') as channel_name,
              request.requested_at
         from project_members reviewer
         join draft_editorial_requests request
           on request.project_id = reviewer.project_id and request.status = 'open'
         join draft_editorial_workflows workflow
           on workflow.project_id = request.project_id and workflow.draft_id = request.draft_id
          and workflow.state = 'in_review' and workflow.submitted_revision_id = request.revision_id
         join drafts draft on draft.id = request.draft_id and draft.project_id = request.project_id
         join users author on author.id = request.requested_by_user_id
         left join lateral (
           select destination_channel.title, destination_channel.handle
             from draft_destinations destination
             join channels destination_channel
               on destination_channel.id = destination.channel_id
              and destination_channel.project_id = request.project_id
            where destination.draft_id = request.draft_id
            order by destination.channel_id limit 1
         ) channel on true
        where reviewer.project_id = $1 and reviewer.user_id = $2
          and reviewer.status = 'active' and reviewer.role in ('owner','approver')
        order by request.requested_at, request.id
        limit 8`,
      [projectId, userId],
    )
  ).rows;
}

export async function submitBotDraftReview(pool, input) {
  const userId = integer(input.userId, "review user");
  const projectId = integer(input.projectId, "review project");
  const draftId = integer(input.draftId, "review draft");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const membership = (
      await client.query(
        `select role from project_members
          where project_id = $1 and user_id = $2 and status = 'active'
            and role in ('owner','author','approver')`,
        [projectId, userId],
      )
    ).rows[0];
    if (!membership) throw new Error("review_permission_denied");
    const workflow = (
      await client.query(
        `select workflow.version, workflow.state, workflow.current_revision_id,
                revision.content_hash
           from draft_editorial_workflows workflow
           join draft_revisions revision
             on revision.id = workflow.current_revision_id
            and revision.project_id = workflow.project_id and revision.draft_id = workflow.draft_id
          where workflow.project_id = $1 and workflow.draft_id = $2
          for update of workflow`,
        [projectId, draftId],
      )
    ).rows[0];
    if (!workflow) throw new Error("review_revision_missing");
    if (workflow.state === "in_review") {
      await client.query("commit");
      return { status: "already_open" };
    }
    if (workflow.state === "approved") throw new Error("review_already_approved");
    const request = (
      await client.query(
        `insert into draft_editorial_requests (
           project_id, draft_id, revision_id, content_hash, requested_by_user_id
         ) values ($1, $2, $3, $4, $5)
         returning id, version`,
        [projectId, draftId, workflow.current_revision_id, workflow.content_hash, userId],
      )
    ).rows[0];
    await client.query(
      `update draft_editorial_workflows
          set state = 'in_review', version = version + 1,
              submitted_revision_id = current_revision_id, submitted_by_user_id = $3,
              submitted_at = now(), approved_revision_id = null,
              approved_content_hash = null, updated_at = now()
        where project_id = $1 and draft_id = $2`,
      [projectId, draftId, userId],
    );
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         before_version, after_version, safe_data, idempotency_key
       ) values ($1, $2, 'draft.review_submitted', 'editorial_request', $3::text,
                 $4, $4 + 1, $5::jsonb, $6)
       on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
      [
        projectId,
        userId,
        request.id,
        workflow.version,
        JSON.stringify({ draftId, revisionId: Number(workflow.current_revision_id), contentHash: workflow.content_hash, source: "telegram_bot" }),
        `editorial-request:${request.id}:submitted`,
      ],
    );
    await client.query(
      `insert into project_notifications (
         project_id, recipient_user_id, actor_user_id, event_type,
         entity_type, entity_id, safe_data, idempotency_key
       )
       select $1, member.user_id, $2, 'draft_review_requested', 'draft', $3::text,
              $4::jsonb, $5 || member.user_id::text
         from project_members member
        where member.project_id = $1 and member.status = 'active'
          and member.role in ('owner','approver') and member.user_id <> $2
       on conflict (project_id, recipient_user_id, idempotency_key)
         where idempotency_key is not null do nothing`,
      [projectId, userId, draftId, JSON.stringify({ requestId: Number(request.id), revisionId: Number(workflow.current_revision_id) }), `editorial-request:${request.id}:reviewer:`],
    );
    await client.query("commit");
    return { status: "submitted", requestId: Number(request.id), requestVersion: Number(request.version) };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function decideBotApproval(pool, input) {
  const userId = integer(input.userId, "decision user");
  const projectId = integer(input.projectId, "decision project");
  const requestId = integer(input.requestId, "decision request");
  const decision = input.decision === "approve" ? "approve" : "request_changes";
  const note = String(input.note || "").trim().slice(0, 4000);
  if (decision === "request_changes" && !note) throw new Error("decision_note_required");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const membership = (
      await client.query(
        `select role from project_members
          where project_id = $1 and user_id = $2 and status = 'active'
            and role in ('owner','approver')`,
        [projectId, userId],
      )
    ).rows[0];
    if (!membership) throw new Error("approval_permission_denied");
    const workflow = (
      await client.query(
        `select workflow.draft_id, workflow.version as workflow_version,
                workflow.state, workflow.submitted_revision_id,
                request.version as request_version, request.revision_id,
                request.content_hash, request.requested_by_user_id,
                revision.author_user_id
           from draft_editorial_requests request
           join draft_editorial_workflows workflow
             on workflow.project_id = request.project_id and workflow.draft_id = request.draft_id
           join draft_revisions revision
             on revision.id = request.revision_id and revision.project_id = request.project_id
          where request.project_id = $1 and request.id = $2 and request.status = 'open'
          for update of workflow, request`,
        [projectId, requestId],
      )
    ).rows[0];
    if (!workflow || workflow.state !== "in_review" || Number(workflow.submitted_revision_id) !== Number(workflow.revision_id)) {
      await client.query("rollback");
      return { status: "stale" };
    }
    const inserted = (
      await client.query(
        `insert into draft_editorial_decisions (
           project_id, request_id, draft_id, revision_id, content_hash,
           actor_user_id, decision, note
         ) values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (request_id) do nothing returning id`,
        [projectId, requestId, workflow.draft_id, workflow.revision_id, workflow.content_hash, userId, decision, note || null],
      )
    ).rows[0];
    if (!inserted) {
      await client.query("rollback");
      return { status: "stale" };
    }
    const nextState = decision === "approve" ? "approved" : "changes_requested";
    const updatedRequest = await client.query(
      `update draft_editorial_requests
          set status = $3, version = version + 1, resolved_by_user_id = $4, resolved_at = now()
        where project_id = $1 and id = $2 and status = 'open' and version = $5`,
      [projectId, requestId, nextState, userId, workflow.request_version],
    );
    const updatedWorkflow = await client.query(
      `update draft_editorial_workflows
          set state = $3, version = version + 1,
              approved_revision_id = case when $3 = 'approved' then $4 else null end,
              approved_content_hash = case when $3 = 'approved' then $5 else null end,
              updated_at = now()
        where project_id = $1 and draft_id = $2 and state = 'in_review'
          and version = $6 and submitted_revision_id = $4`,
      [projectId, workflow.draft_id, nextState, workflow.revision_id, workflow.content_hash, workflow.workflow_version],
    );
    if (!updatedRequest.rowCount || !updatedWorkflow.rowCount) throw new Error("approval_stale_write");
    await client.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         before_version, after_version, safe_data, idempotency_key
       ) values ($1, $2, $3, 'editorial_decision', $4::text, $5, $5 + 1, $6::jsonb, $7)
       on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
      [projectId, userId, decision === "approve" ? "draft.approved" : "draft.changes_requested", inserted.id, workflow.workflow_version, JSON.stringify({ draftId: Number(workflow.draft_id), requestId, revisionId: Number(workflow.revision_id), source: "telegram_bot" }), `editorial-decision:${inserted.id}:recorded`],
    );
    await client.query(
      `insert into project_notifications (
         project_id, recipient_user_id, actor_user_id, event_type,
         entity_type, entity_id, safe_data, idempotency_key
       )
       select $1, recipient_id, $2, $3, 'draft', $4::text, $5::jsonb, $6 || recipient_id::text
         from unnest($7::bigint[]) recipient_id
        where recipient_id <> $2
       on conflict (project_id, recipient_user_id, idempotency_key)
         where idempotency_key is not null do nothing`,
      [projectId, userId, decision === "approve" ? "draft_approved" : "draft_changes_requested", workflow.draft_id, JSON.stringify({ requestId, revisionId: Number(workflow.revision_id) }), `editorial-decision:${inserted.id}:participant:`, [workflow.requested_by_user_id, workflow.author_user_id]],
    );
    await client.query("commit");
    return { status: nextState, draftId: Number(workflow.draft_id) };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
