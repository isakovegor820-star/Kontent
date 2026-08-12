import { createHash, randomUUID } from "node:crypto";

import { Worker } from "bullmq";

export const PUBLICATION_REVIEW_REMINDER_QUEUE = "publication-review-reminder";
const DISPATCH_LEASE_SECONDS = 90;
const AMBIGUOUS_DELIVERY_SECONDS = 600;

function boundedLimit(value, fallback = 100) {
  return Math.max(1, Math.min(500, Number(value) || fallback));
}

function safeErrorCode(error, fallback = "reminder_dispatch_failed") {
  const candidate = String(error?.code || fallback).trim().toLowerCase();
  return /^[a-z0-9_:-]{1,100}$/u.test(candidate) ? candidate : fallback;
}

export function publicationReviewReminderJobKey({ projectId, reviewTaskId, recipientUserId }) {
  return createHash("sha256")
    .update(`publication-review-reminder:v1:${projectId}:${reviewTaskId}:${recipientUserId}`, "utf8")
    .digest("hex");
}

export async function enqueuePublicationReviewReminderJob(data, queue) {
  if (!data || !/^[0-9a-f]{64}$/u.test(String(data.jobKey || ""))) {
    throw new Error("invalid_publication_review_reminder_job");
  }
  return queue.add("deliver", data, {
    jobId: data.jobKey,
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: false,
  });
}

/**
 * Moves due, still-valid reviews to the durable outbox. A review is never made due
 * for an unpublished post, inactive destination or revoked assignee.
 */
export async function markDuePublicationReviews({ pool, limit = 100 }) {
  const bounded = boundedLimit(limit);
  const client = await pool.connect();
  let dueCount = 0;
  let cancelledCount = 0;
  try {
    await client.query("begin");
    const invalid = await client.query(
      `update publication_review_tasks task
          set status = 'cancelled', reminder_status = 'cancelled',
              version = version + 1, updated_at = now()
         from posts post
         left join channels channel
           on channel.id = post.channel_id and channel.project_id = post.project_id
        where task.post_id = post.id and task.project_id = post.project_id
          and task.status in ('scheduled','due')
          and task.reminder_status in ('pending','failed')
          and task.review_at <= now()
          and (
            post.status in ('missing','deleted_external','cancelled','failed')
            or channel.id is null or channel.is_active is not true or channel.status <> 'active'
            or not exists (
              select 1 from projects project
               where project.id = task.project_id and project.is_archived is not true
            )
            or not exists (
              select 1 from project_members member
               where member.project_id = task.project_id
                 and member.user_id = task.responsible_user_id
                 and member.status = 'active'
            )
          )
        returning task.id, task.project_id`,
    );
    cancelledCount = invalid.rowCount || 0;
    for (const row of invalid.rows) {
      await client.query(
        `update publication_review_reminder_outbox
            set status = 'cancelled', lease_token = null, lease_expires_at = null,
                updated_at = now()
          where project_id = $1 and review_task_id = $2
            and status <> 'completed'`,
        [row.project_id, row.id],
      );
    }

    const due = await client.query(
      `select task.id, task.project_id, task.post_id, task.responsible_user_id,
              task.review_at, task.timezone, task.version,
              post.channel_id, channel.title
         from publication_review_tasks task
         join posts post
           on post.id = task.post_id and post.project_id = task.project_id
          and post.status = 'published'
         join channels channel
           on channel.id = post.channel_id and channel.project_id = task.project_id
          and channel.is_active is true and channel.status = 'active'
         join projects project
           on project.id = task.project_id and project.is_archived is not true
         join project_members member
           on member.project_id = task.project_id
          and member.user_id = task.responsible_user_id
          and member.status = 'active'
        where task.status = 'scheduled' and task.reminder_status = 'pending'
          and task.review_at <= now()
        order by task.review_at, task.id
        limit $1 for update of task skip locked`,
      [bounded],
    );
    for (const row of due.rows) {
      const updated = await client.query(
        `update publication_review_tasks
            set status = 'due', version = version + 1, updated_at = now()
          where id = $1 and project_id = $2
            and status = 'scheduled' and reminder_status = 'pending'
        returning version`,
        [row.id, row.project_id],
      );
      if (!updated.rows[0]) continue;
      const nextVersion = Number(updated.rows[0].version);
      const jobKey = publicationReviewReminderJobKey({
        projectId: row.project_id,
        reviewTaskId: row.id,
        recipientUserId: row.responsible_user_id,
      });
      await client.query(
        `insert into project_notifications
           (project_id, recipient_user_id, actor_user_id, event_type,
            entity_type, entity_id, safe_data, idempotency_key)
         values ($1, $2, null, 'publication_review_due', 'publication_review_task', $3::text,
                 jsonb_build_object(
                   'post_id', $4::bigint,
                   'review_at', $5::timestamptz,
                   'channel_id', $6::bigint,
                   'destination', jsonb_build_object(
                     'kind', 'publication_review',
                     'path', '/app/calendar',
                     'review_task_id', ($3::text)::bigint
                   )
                 ), $7)
         on conflict (project_id, recipient_user_id, idempotency_key)
           where idempotency_key is not null do nothing`,
        [
          row.project_id,
          row.responsible_user_id,
          String(row.id),
          row.post_id,
          row.review_at,
          row.channel_id,
          `publication-review:${row.id}:due`,
        ],
      );
      await client.query(
        `insert into audit_events
           (project_id, actor_user_id, action, entity_type, entity_id,
            before_version, after_version, safe_data, idempotency_key)
         values ($1, null, 'publication.review.due', 'publication_review_task', $2,
                 $3, $4, jsonb_build_object('post_id', $5::bigint), $6)
         on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
        [
          row.project_id,
          String(row.id),
          Number(row.version),
          nextVersion,
          row.post_id,
          `audit:publication-review:${row.id}:due`,
        ],
      );
      await client.query(
        `insert into publication_review_reminder_outbox
           (project_id, review_task_id, recipient_user_id, job_key, status)
         values ($1, $2, $3, $4, 'pending')
         on conflict (project_id, review_task_id) do update
           set recipient_user_id = excluded.recipient_user_id,
               job_key = excluded.job_key,
               status = case
                 when publication_review_reminder_outbox.status = 'completed'
                   then publication_review_reminder_outbox.status
                 else 'pending'
               end,
               next_attempt_at = now(), last_error_code = null,
               lease_token = null, lease_expires_at = null, updated_at = now()`,
        [row.project_id, row.id, row.responsible_user_id, jobKey],
      );
      dueCount += 1;
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return { due: dueCount, cancelled: cancelledCount };
}

/** Rebuilds Redis state from PostgreSQL. Queue loss therefore cannot lose a reminder. */
export async function reconcilePublicationReviewReminderOutbox({ pool, enqueue, limit = 100 }) {
  const bounded = boundedLimit(limit);
  await pool.query(
    `update publication_review_reminder_outbox
        set status = 'failed', last_error_code = 'dispatch_lease_expired',
            next_attempt_at = now(), lease_token = null, lease_expires_at = null,
            updated_at = now()
      where status = 'dispatching' and lease_expires_at <= now()`,
  );
  await pool.query(
    `update publication_review_reminder_outbox
        set status = 'pending', next_attempt_at = now(), updated_at = now()
      where status = 'enqueued' and enqueued_at <= now() - interval '10 minutes'`,
  );
  const candidates = await pool.query(
    `select outbox.id, outbox.project_id, outbox.review_task_id,
            outbox.recipient_user_id, outbox.job_key
       from publication_review_reminder_outbox outbox
       join publication_review_tasks task
         on task.id = outbox.review_task_id and task.project_id = outbox.project_id
      where outbox.status in ('pending','failed') and outbox.next_attempt_at <= now()
        and task.status = 'due' and task.reminder_status = 'pending'
      order by outbox.next_attempt_at, outbox.id
      limit $1`,
    [bounded],
  );
  let enqueued = 0;
  let failed = 0;
  for (const row of candidates.rows) {
    const leaseToken = createHash("sha256").update(randomUUID()).digest("hex");
    const claimed = await pool.query(
      `update publication_review_reminder_outbox
          set status = 'dispatching', attempts = attempts + 1,
              lease_token = $3, lease_expires_at = now() + ($4::text || ' seconds')::interval,
              updated_at = now()
        where id = $1 and project_id = $2
          and status in ('pending','failed') and next_attempt_at <= now()`,
      [row.id, row.project_id, leaseToken, String(DISPATCH_LEASE_SECONDS)],
    );
    if (claimed.rowCount !== 1) continue;
    try {
      await enqueue({
        projectId: Number(row.project_id),
        reviewTaskId: Number(row.review_task_id),
        recipientUserId: Number(row.recipient_user_id),
        jobKey: String(row.job_key),
      });
      const saved = await pool.query(
        `update publication_review_reminder_outbox
            set status = 'enqueued', enqueued_at = now(),
                lease_token = null, lease_expires_at = null,
                last_error_code = null, updated_at = now()
          where id = $1 and project_id = $2 and status = 'dispatching' and lease_token = $3`,
        [row.id, row.project_id, leaseToken],
      );
      if (saved.rowCount === 1) enqueued += 1;
    } catch (error) {
      await pool.query(
        `update publication_review_reminder_outbox
            set status = 'failed', last_error_code = $4,
                next_attempt_at = now() + interval '30 seconds',
                lease_token = null, lease_expires_at = null, updated_at = now()
          where id = $1 and project_id = $2 and status = 'dispatching' and lease_token = $3`,
        [row.id, row.project_id, leaseToken, safeErrorCode(error)],
      );
      failed += 1;
    }
  }
  return { candidates: candidates.rowCount || candidates.rows.length, enqueued, failed };
}

async function markReminderIneligible(pool, data, errorCode) {
  await pool.query(
    `with cancelled as (
       update publication_review_tasks
          set status = case when status in ('scheduled','due') then 'cancelled' else status end,
              reminder_status = case when reminder_status in ('pending','failed') then 'cancelled' else reminder_status end,
              reminder_last_error_code = $4,
              version = version + 1, updated_at = now()
        where id = $1 and project_id = $2
          and reminder_status in ('pending','failed')
      returning id
     )
     update publication_review_reminder_outbox
        set status = 'cancelled', last_error_code = $4,
            lease_token = null, lease_expires_at = null, updated_at = now()
      where review_task_id = $1 and project_id = $2 and job_key = $3
        and status in ('pending','failed','dispatching','enqueued')`,
    [data.reviewTaskId, data.projectId, data.jobKey, errorCode],
  );
}

/** One job owns at most one external call. An ambiguous call is never repeated. */
export async function processPublicationReviewReminderJob({ pool, notifyUser, data }) {
  if (
    !data
    || !Number.isSafeInteger(Number(data.projectId))
    || !Number.isSafeInteger(Number(data.reviewTaskId))
    || !/^[0-9a-f]{64}$/u.test(String(data.jobKey || ""))
  ) {
    return { status: "skipped", reason: "invalid_job" };
  }
  const projectId = Number(data.projectId);
  const reviewTaskId = Number(data.reviewTaskId);
  const client = await pool.connect();
  let claimed;
  try {
    await client.query("begin");
    const current = await client.query(
      `select task.id, task.project_id, task.responsible_user_id,
              task.reminder_status, task.status, task.review_at,
              post.status as post_status, channel.is_active, channel.status as channel_status,
              channel.title, project.is_archived, member.status as member_status,
              app_user.tg_chat_id, outbox.status as outbox_status,
              outbox.job_key
         from publication_review_tasks task
         join posts post on post.id = task.post_id and post.project_id = task.project_id
         join channels channel on channel.id = post.channel_id and channel.project_id = task.project_id
         join projects project on project.id = task.project_id
         join project_members member
           on member.project_id = task.project_id and member.user_id = task.responsible_user_id
         join users app_user on app_user.id = task.responsible_user_id
         join publication_review_reminder_outbox outbox
           on outbox.review_task_id = task.id and outbox.project_id = task.project_id
        where task.id = $1 and task.project_id = $2 and outbox.job_key = $3
        for update of task, outbox
        for share of post, channel, project, member`,
      [reviewTaskId, projectId, data.jobKey],
    );
    const row = current.rows[0];
    if (!row) {
      await client.query("commit");
      return { status: "skipped", reason: "not_found" };
    }
    if (["completed", "cancelled"].includes(row.outbox_status)) {
      await client.query("commit");
      return { status: "skipped", reason: row.outbox_status };
    }
    const eligible = row.status === "due"
      && row.reminder_status === "pending"
      && row.post_status === "published"
      && row.is_active === true
      && row.channel_status === "active"
      && row.is_archived === false
      && row.member_status === "active";
    if (!eligible) {
      await client.query("rollback");
      await markReminderIneligible(pool, { projectId, reviewTaskId, jobKey: data.jobKey }, "reminder_ineligible");
      return { status: "cancelled", reason: "ineligible" };
    }
    if (row.tg_chat_id == null) {
      await client.query(
        `update publication_review_tasks
            set reminder_status = 'failed', reminder_last_error_code = 'telegram_not_connected',
                reminder_attempts = reminder_attempts + 1,
                version = version + 1, updated_at = now()
          where id = $1 and project_id = $2 and reminder_status = 'pending'`,
        [reviewTaskId, projectId],
      );
      await client.query(
        `update publication_review_reminder_outbox
            set status = 'completed', attempts = attempts + 1,
                last_error_code = 'telegram_not_connected', updated_at = now()
          where review_task_id = $1 and project_id = $2 and job_key = $3`,
        [reviewTaskId, projectId, data.jobKey],
      );
      await client.query("commit");
      return { status: "failed", reason: "telegram_not_connected" };
    }
    const providerStartedAt = new Date();
    const taskClaim = await client.query(
      `update publication_review_tasks
          set reminder_status = 'sending', reminder_provider_started_at = $3,
              reminder_last_error_code = null, reminder_attempts = reminder_attempts + 1,
              version = version + 1, updated_at = now()
        where id = $1 and project_id = $2 and status = 'due' and reminder_status = 'pending'`,
      [reviewTaskId, projectId, providerStartedAt],
    );
    const outboxClaim = await client.query(
      `update publication_review_reminder_outbox
          set status = 'running', attempts = attempts + 1,
              lease_token = null, lease_expires_at = null, updated_at = now()
        where review_task_id = $1 and project_id = $2 and job_key = $3
          and status in ('enqueued','pending','failed')`,
      [reviewTaskId, projectId, data.jobKey],
    );
    if (taskClaim.rowCount !== 1 || outboxClaim.rowCount !== 1) {
      await client.query("rollback");
      return { status: "skipped", reason: "claim_conflict" };
    }
    await client.query("commit");
    claimed = {
      responsibleUserId: Number(row.responsible_user_id),
      title: row.title == null ? null : String(row.title),
      providerStartedAt,
    };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  let delivered = false;
  let errorCode = "reminder_delivery_failed";
  try {
    delivered = await notifyUser(
      claimed.responsibleUserId,
      `Пора проверить актуальность публикации${claimed.title ? ` в «${claimed.title}»` : ""}. `
        + "Откройте календарь и выберите: оставить, обновить, открепить или снять вручную.",
    ) === true;
  } catch (error) {
    errorCode = safeErrorCode(error, errorCode);
  }
  const deliveryStatus = delivered ? "sent" : "failed";
  const finalized = await pool.query(
    `with task_result as (
       update publication_review_tasks
          set reminder_status = $4,
              reminder_sent_at = case when $4 = 'sent' then now() else reminder_sent_at end,
              reminder_last_error_code = case when $4 = 'sent' then null else $5 end,
              version = version + 1, updated_at = now()
        where id = $1 and project_id = $2 and reminder_status = 'sending'
          and reminder_provider_started_at = $3
      returning id
     )
     update publication_review_reminder_outbox
        set status = 'completed', last_error_code = case when $4 = 'sent' then null else $5 end,
            updated_at = now()
      where review_task_id = $1 and project_id = $2 and job_key = $6
        and status = 'running' and exists (select 1 from task_result)`,
    [reviewTaskId, projectId, claimed.providerStartedAt, deliveryStatus, errorCode, data.jobKey],
  );
  return finalized.rowCount === 1
    ? { status: deliveryStatus }
    : { status: "unknown", reason: "finalize_conflict" };
}

/** A provider-started job left behind by a crash is terminally unknown, never retried. */
export async function recoverAmbiguousPublicationReviewReminders({ pool }) {
  const result = await pool.query(
    `with abandoned as (
       update publication_review_tasks task
          set reminder_status = 'failed', reminder_last_error_code = 'delivery_unknown',
              version = version + 1, updated_at = now()
         from publication_review_reminder_outbox outbox
        where outbox.review_task_id = task.id and outbox.project_id = task.project_id
          and outbox.status = 'running' and task.reminder_status = 'sending'
          and task.reminder_provider_started_at <= now() - ($1::text || ' seconds')::interval
      returning task.id, task.project_id
     )
     update publication_review_reminder_outbox outbox
        set status = 'completed', last_error_code = 'delivery_unknown', updated_at = now()
       from abandoned
      where outbox.review_task_id = abandoned.id and outbox.project_id = abandoned.project_id
        and outbox.status = 'running'`,
    [String(AMBIGUOUS_DELIVERY_SECONDS)],
  );
  return { recovered: result.rowCount || 0 };
}

export async function processDuePublicationReviews({ pool, enqueue, limit = 100 }) {
  const recovered = await recoverAmbiguousPublicationReviewReminders({ pool });
  const marked = await markDuePublicationReviews({ pool, limit });
  const dispatch = await reconcilePublicationReviewReminderOutbox({ pool, enqueue, limit });
  return { ...marked, ...dispatch, recovered: recovered.recovered };
}

export function createPublicationReviewReminderWorker({
  connection,
  pool,
  notifyUser,
  concurrency = 1,
  WorkerClass = Worker,
}) {
  return new WorkerClass(
    PUBLICATION_REVIEW_REMINDER_QUEUE,
    (job) => processPublicationReviewReminderJob({ pool, notifyUser, data: job.data }),
    { connection, concurrency },
  );
}
