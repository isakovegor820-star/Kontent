import { activateNextPublicationExtra } from "../src/lib/publication-extra-operations.mjs";
import { reconcilePublicationExtraOutbox } from "../src/lib/publication-extra-outbox.mjs";

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`invalid_${label}`);
  return id;
}
/**
 * Connects a confirmed main publication to its durable follow-up outbox. The caller
 * deliberately handles failures separately: a comment or pin must never downgrade a
 * provider-confirmed main post.
 */
export async function triggerPublicationExtrasAfterPublish({
  pool,
  projectId,
  postId,
  enqueue,
  activate = activateNextPublicationExtra,
  reconcile = reconcilePublicationExtraOutbox,
}) {
  const scopedProjectId = positiveId(projectId, "project_id");
  const scopedPostId = positiveId(postId, "post_id");
  const operationId = await activate(pool, {
    projectId: scopedProjectId,
    postId: scopedPostId,
  });
  if (operationId == null) {
    return { operationId: null, scanned: 0, enqueued: 0, failed: 0 };
  }
  const dispatch = await reconcile({
    pool,
    enqueue,
    operationId: positiveId(operationId, "operation_id"),
    limit: 1,
  });
  return { operationId: Number(operationId), ...dispatch };
}

/**
 * PostgreSQL remains the source of truth after a worker/Redis restart. Before replaying
 * the outbox, promote one dependency-satisfied action for every confirmed post that
 * still has work. This also repairs a crash between saving the main external id and
 * creating the first extra outbox row.
 */
export async function reconcilePublicationExtraRuntime({
  pool,
  enqueue,
  limit = 200,
  activate = activateNextPublicationExtra,
  reconcile = reconcilePublicationExtraOutbox,
}) {
  const bounded = Math.max(1, Math.min(500, Number(limit) || 200));
  const candidates = await pool.query(
    `select distinct extra.project_id, extra.post_id
       from publication_extra_operations extra
       join posts post on post.id = extra.post_id and post.project_id = extra.project_id
      where post.status = 'published'
        and extra.status in ('waiting_dependency','pending','failed_retry','queued')
      order by extra.project_id, extra.post_id
      limit $1`,
    [bounded],
  );
  let activated = 0;
  for (const row of candidates.rows) {
    const operationId = await activate(pool, {
      projectId: positiveId(row.project_id, "project_id"),
      postId: positiveId(row.post_id, "post_id"),
    });
    if (operationId != null) activated += 1;
  }
  const dispatch = await reconcile({ pool, enqueue, limit: bounded });
  return { candidates: candidates.rows.length, activated, ...dispatch };
}
