import { draftRevisionContentHash } from "../src/lib/editorial-revision.mjs";

function iso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function snapshotFromDraft(row) {
  const channelIds = Array.isArray(row.channel_ids)
    ? row.channel_ids.map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right)
    : [];
  return {
    schemaVersion: 3,
    text: row.text,
    media: row.media ?? null,
    tracking: row.tracking ?? null,
    origin: row.origin,
    purpose: row.purpose,
    sourceRef: row.source_ref ?? null,
    schedule: {
      scheduledAt: row.scheduled_at == null ? null : iso(row.scheduled_at),
      timezone: row.scheduled_timezone,
      localDate: row.scheduled_local_date == null ? null : String(row.scheduled_local_date).slice(0, 10),
      localTime: row.scheduled_local_time == null ? null : String(row.scheduled_local_time).slice(0, 5),
      offset: row.scheduled_offset,
      disambiguation: row.scheduled_disambiguation,
    },
    channelIds,
    publicationPreferences: row.publication_preferences ?? {
      version: 0,
      selectedBlocks: [],
      firstCommentFallback: "skip",
      commentsMode: "provider_default",
      pinAfterPublish: false,
      reviewAt: null,
      reviewResponsibleUserId: null,
    },
  };
}

/**
 * Background-created drafts must satisfy the same immutable editorial invariant as
 * drafts written through the HTTP API. Call this inside the draft transaction after
 * destinations are persisted.
 */
export async function ensureDraftEditorialBootstrap(db, input) {
  const membership = await db.query(
    `select member.role
       from project_members member
       join projects project on project.id = member.project_id
      where member.project_id = $1 and member.user_id = $2
        and member.status = 'active' and project.is_archived = false
        and member.role in ('owner', 'author', 'approver')
      limit 1`,
    [input.projectId, input.actorUserId],
  );
  if (!membership.rows[0]) throw new Error("draft actor cannot edit project content");

  const draftResult = await db.query(
    `select draft.id, draft.project_id, draft.user_id, draft.version,
            draft.text, draft.media, draft.tracking, draft.origin, draft.purpose, draft.source_ref,
            draft.scheduled_at, draft.scheduled_timezone,
            to_char(draft.scheduled_local_date, 'YYYY-MM-DD') as scheduled_local_date,
            to_char(draft.scheduled_local_time, 'HH24:MI') as scheduled_local_time,
            draft.scheduled_offset, draft.scheduled_disambiguation,
            coalesce((
              select array_agg(destination.channel_id order by destination.channel_id)
                from draft_destinations destination
               where destination.draft_id = draft.id
            ), '{}') as channel_ids,
            coalesce((
              select jsonb_build_object(
                'version', preference.version,
                'selectedBlocks', coalesce((
                  select jsonb_agg(jsonb_build_object(
                    'id', block.id,
                    'kind', block.kind,
                    'name', block.name,
                    'text', block.body,
                    'version', block.version
                  ) order by selection.position)
                    from jsonb_array_elements_text(preference.selected_block_ids)
                         with ordinality as selection(block_id, position)
                    join project_publication_blocks block
                      on block.id = selection.block_id::bigint
                     and block.project_id = preference.project_id
                ), '[]'::jsonb),
                'firstCommentFallback', preference.first_comment_fallback,
                'commentsMode', preference.comments_mode,
                'pinAfterPublish', preference.pin_after_publish,
                'reviewAt', preference.review_at,
                'reviewResponsibleUserId', preference.review_responsible_user_id
              )
                from draft_publication_preferences preference
               where preference.draft_id = draft.id and preference.project_id = draft.project_id
            ), jsonb_build_object(
              'version', 0,
              'selectedBlocks', '[]'::jsonb,
              'firstCommentFallback', 'skip',
              'commentsMode', 'provider_default',
              'pinAfterPublish', false,
              'reviewAt', null,
              'reviewResponsibleUserId', null
            )) as publication_preferences
       from drafts draft
      where draft.id = $1 and draft.project_id = $2
      for update of draft`,
    [input.draftId, input.projectId],
  );
  const draft = draftResult.rows[0];
  if (!draft) throw new Error("draft disappeared before editorial bootstrap");

  const draftVersion = Number(draft.version);
  const snapshot = snapshotFromDraft(draft);
  const contentHash = draftRevisionContentHash(snapshot);
  const inserted = await db.query(
    `insert into draft_revisions (
       project_id, draft_id, draft_version, author_user_id, content_hash, snapshot
     ) values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (draft_id, draft_version) do nothing
     returning id`,
    [input.projectId, input.draftId, draftVersion, input.actorUserId, contentHash, JSON.stringify(snapshot)],
  );
  let revisionId = inserted.rows[0] ? Number(inserted.rows[0].id) : 0;
  if (!revisionId) {
    const existing = await db.query(
      `select id, content_hash
         from draft_revisions
        where project_id = $1 and draft_id = $2 and draft_version = $3`,
      [input.projectId, input.draftId, draftVersion],
    );
    if (!existing.rows[0] || existing.rows[0].content_hash !== contentHash) {
      throw new Error("draft revision conflicts with persisted content");
    }
    revisionId = Number(existing.rows[0].id);
  }

  const workflow = await db.query(
    `insert into draft_editorial_workflows (
       draft_id, project_id, state, version, current_revision_id
     ) values ($1, $2, 'draft', 1, $3)
     on conflict (draft_id) do nothing
     returning draft_id`,
    [input.draftId, input.projectId, revisionId],
  );
  if (!workflow.rowCount) {
    await db.query(
      `update draft_editorial_requests
          set status = 'superseded', version = version + 1, resolved_at = now()
        where project_id = $1 and draft_id = $2 and status = 'open'
          and revision_id <> $3`,
      [input.projectId, input.draftId, revisionId],
    );
    await db.query(
      `update draft_editorial_workflows
          set current_revision_id = $3,
              state = case when current_revision_id = $3 then state else 'draft' end,
              submitted_revision_id = case when current_revision_id = $3 then submitted_revision_id else null end,
              submitted_by_user_id = case when current_revision_id = $3 then submitted_by_user_id else null end,
              submitted_at = case when current_revision_id = $3 then submitted_at else null end,
              approved_revision_id = case when current_revision_id = $3 then approved_revision_id else null end,
              approved_content_hash = case when current_revision_id = $3 then approved_content_hash else null end,
              version = case when current_revision_id = $3 then version else version + 1 end,
              updated_at = now()
        where project_id = $1 and draft_id = $2`,
      [input.projectId, input.draftId, revisionId],
    );
  }
  await db.query(
    `insert into audit_events (
       project_id, actor_user_id, action, entity_type, entity_id,
       after_version, safe_data, idempotency_key
     ) values ($1, $2, 'draft.revision_created', 'draft_revision', $3::text,
               $4, $5::jsonb, $6)
     on conflict (project_id, idempotency_key)
       where idempotency_key is not null do nothing`,
    [
      input.projectId,
      input.actorUserId,
      revisionId,
      draftVersion,
      JSON.stringify({ draftId: input.draftId, draftVersion, contentHash }),
      `draft:${input.draftId}:revision:${revisionId}:created`,
    ],
  );
  return { revisionId, contentHash, snapshot };
}
