export async function claimPublicationLease(pool, input) {
  const scheduled = await pool.query(
    `update posts p
        set status = 'publishing', publish_started_at = now(), provider_started_at = null,
            publish_lease_token = $2
      where p.id = $1 and p.status = 'scheduled'
        and p.schedule_revision = $3
        and p.project_id = $5
        and p.scheduled_at >= $4
        and p.scheduled_at <= now() + interval '30 seconds'
        and not exists (
          select 1
            from rss_items ri
            join rss_feeds rf on rf.id = ri.feed_id
           where ri.post_id = p.id and rf.is_active = false
        )
      returning p.id, p.project_id, p.user_id, p.channel_id, p.text, p.media, p.attempts,
                p.publication_operation_id`,
    [input.postId, input.leaseToken, input.scheduleRevision, input.overdueCutoff, input.projectId],
  );
  if (scheduled.rowCount > 0) return scheduled.rows[0];
  const retry = await pool.query(
    `update posts p
        set status = 'publishing', publish_started_at = now(), provider_started_at = null,
            publish_lease_token = $2
      where p.id = $1 and p.status = 'failed_retry'
        and p.schedule_revision = $3
        and p.project_id = $4
        and p.next_attempt_at is not null
        and p.next_attempt_at <= now() + interval '30 seconds'
      returning p.id, p.project_id, p.user_id, p.channel_id, p.text, p.media, p.attempts,
                p.publication_operation_id`,
    [input.postId, input.leaseToken, input.scheduleRevision, input.projectId],
  );
  return retry.rows[0] ?? null;
}

/**
 * Final DB fence immediately before the first external byte can be sent. A committed
 * cancel/reschedule wins by changing status/revision; a started provider call wins by
 * persisting provider_started_at, after which the API must return publication_in_progress.
 */
export async function beginProviderCall(pool, input) {
  const started = await pool.query(
    `update posts
        set provider_started_at = now()
      where id = $1 and status = 'publishing'
        and schedule_revision = $2
        and publish_lease_token = $3
        and project_id = $4
        and provider_started_at is null
      returning id`,
    [input.postId, input.scheduleRevision, input.leaseToken, input.projectId],
  );
  return started.rowCount === 1;
}
