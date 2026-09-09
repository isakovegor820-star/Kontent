import { PROJECT_ROLES, roleAllows } from "../src/lib/project-role-policy.mjs";

const publisherRoles = PROJECT_ROLES.filter((role) => roleAllows(role, "content.publish"))
  .map((role) => `'${role}'`).join(",");

// posts.user_id is the actor who admitted the schedule, not the author or channel
// connector. Row locks serialize this admission with committed/in-flight revocation;
// an already admitted provider request cannot be recalled by a later revocation.
function channelIdentity(channel) {
  if (!channel) return null;
  const stringOrNull = (value) => value == null ? null : String(value);
  return JSON.stringify({network:channel.network,tg_chat_id:stringOrNull(channel.tg_chat_id),
    vk_group_id:stringOrNull(channel.vk_group_id),vk_token:stringOrNull(channel.vk_token),
    oauth_token_id:stringOrNull(channel.oauth_token_id)});
}

function authorityFence(projectParameter, expectedParameter = null) {
  return `with locked_post as materialized (
    select * from posts where id = $1 and project_id = ${projectParameter} for update
  ), oauth_credentials as materialized (
    select token.id
      from locked_post candidate
      join channels channel on channel.id = candidate.channel_id
      join oauth_tokens token on token.id = channel.oauth_token_id
        and token.user_id = channel.user_id and token.provider = channel.network and token.is_active
     for share of token
  ), authorized as materialized (
    select candidate.id
      from locked_post candidate
      join projects project on project.id = candidate.project_id and not project.is_archived
      join users actor on actor.id = candidate.user_id and actor.blocked_at is null
      join project_members member on member.project_id = candidate.project_id
        and member.user_id = candidate.user_id and member.status = 'active'
        and member.role in (${publisherRoles})
      join channels channel on channel.id = candidate.channel_id
        and channel.project_id = candidate.project_id
        and channel.is_active and channel.status = 'active'
        and (channel.network not in ('youtube','instagram','x','tiktok','linkedin')
          or channel.oauth_token_id in (select id from oauth_credentials))
     where candidate.id = $1 and candidate.project_id = ${projectParameter}
       ${expectedParameter ? `and (${expectedParameter}::jsonb is null or jsonb_build_object(
         'network',channel.network,'tg_chat_id',channel.tg_chat_id::text,
         'vk_group_id',channel.vk_group_id::text,'vk_token',channel.vk_token,
         'oauth_token_id',channel.oauth_token_id::text) = ${expectedParameter}::jsonb)` : ""}
     for update of project for share of member, channel, actor
  )`;
}

export async function claimPublicationLease(pool, input) {
  const scheduled = await pool.query(
    `${authorityFence("$5")}
     update posts p
        set status = 'publishing', publish_started_at = now(), provider_started_at = null,
            publish_lease_token = $2
      where p.id in (select id from authorized) and p.id = $1 and p.status = 'scheduled'
        and p.schedule_revision = $3
        and p.project_id = $5
        and p.scheduled_at >= $4
        and p.scheduled_at <= now() + interval '30 seconds'
        and not exists (
          select 1
            from rss_items ri
            join rss_feeds rf on rf.id = ri.feed_id
           where ri.post_id = p.id
             and (
               rf.is_active = false
               or (rf.source_kind = 'legal_opportunity' and rf.auto_publish_enabled = false)
             )
        )
      returning p.id, p.project_id, p.user_id, p.channel_id, p.text, p.media, p.attempts,
                p.publication_operation_id, p.publication_origin, p.publication_draft_version`,
    [input.postId, input.leaseToken, input.scheduleRevision, input.overdueCutoff, input.projectId],
  );
  if (scheduled.rowCount > 0) return scheduled.rows[0];
  const retry = await pool.query(
    `${authorityFence("$4")}
     update posts p
        set status = 'publishing', publish_started_at = now(), provider_started_at = null,
            publish_lease_token = $2
      where p.id in (select id from authorized) and p.id = $1 and p.status = 'failed_retry'
        and p.schedule_revision = $3
        and p.project_id = $4
        and p.next_attempt_at is not null
        and p.next_attempt_at <= now() + interval '30 seconds'
        and not exists (
          select 1
            from rss_items ri
            join rss_feeds rf on rf.id = ri.feed_id
           where ri.post_id = p.id
             and (
               rf.is_active = false
               or (rf.source_kind = 'legal_opportunity' and rf.auto_publish_enabled = false)
             )
        )
      returning p.id, p.project_id, p.user_id, p.channel_id, p.text, p.media, p.attempts,
                p.publication_operation_id, p.publication_origin, p.publication_draft_version`,
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
    `${authorityFence("$4", "$5")}
     update posts
        set provider_started_at = now()
      where id in (select id from authorized) and id = $1 and status = 'publishing'
        and schedule_revision = $2
        and publish_lease_token = $3
        and project_id = $4
        and provider_started_at is null
        and not exists (
          select 1
            from rss_items ri
            join rss_feeds rf on rf.id = ri.feed_id
           where ri.post_id = posts.id
             and (
               rf.is_active = false
               or (rf.source_kind = 'legal_opportunity' and rf.auto_publish_enabled = false)
             )
        )
      returning id`,
    [input.postId, input.scheduleRevision, input.leaseToken, input.projectId, channelIdentity(input.expectedChannel)],
  );
  return started.rowCount === 1;
}

/** Each multipart byte has a separate admission; sent receipts are never changed. */
export async function claimPublicationPart(pool, input) {
  if (!input?.leaseToken || !input?.scheduleRevision || !input?.projectId) return { rowCount: 0, rows: [] };
  return pool.query(
    `${authorityFence("$4", "$6")}
     update publication_parts part set send_status = 'sending', updated_at = now()
      from posts post
     where part.id = $5 and part.post_id = post.id
       and post.id = $1 and post.id in (select id from authorized)
       and post.status = 'publishing' and post.schedule_revision = $2
       and post.publish_lease_token = $3 and post.project_id = $4
       and post.provider_started_at is not null
       and part.send_status in ('pending','failed') and part.external_message_id is null
     returning part.id`,
    [input.postId, input.scheduleRevision, input.leaseToken, input.projectId, input.partId, channelIdentity(input.expectedChannel)],
  );
}

/** Revalidate each additional provider step after the first durable admission. */
export async function authorizeProviderStep(pool, input) {
  if (!input?.leaseToken || !input?.scheduleRevision || !input?.projectId) return false;
  const result = await pool.query(
    `${authorityFence("$4", "$5")}
     select id from posts where id = $1 and id in (select id from authorized)
       and status = 'publishing' and schedule_revision = $2 and publish_lease_token = $3
       and project_id = $4 and provider_started_at is not null`,
    [input.postId,input.scheduleRevision,input.leaseToken,input.projectId,channelIdentity(input.expectedChannel)],
  );
  return result.rowCount === 1;
}
