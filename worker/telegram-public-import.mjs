function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`telegram public import: bad ${field}`);
  return id;
}

/**
 * Materialize public channel messages that were published outside Aurora.
 * Existing Aurora posts and their multipart messages are deliberately preserved.
 */
export async function importTelegramPublicPosts(db, scope, verification) {
  const projectId = positiveId(scope?.projectId, "projectId");
  const userId = positiveId(scope?.userId, "userId");
  const channelId = positiveId(scope?.channelId, "channelId");
  if (verification?.kind !== "window" || !Array.isArray(verification.posts)) {
    return { discovered: 0, imported: 0 };
  }
  const candidates = [...new Map(verification.posts.flatMap((post) => {
    const externalMessageId = Number(post?.externalMessageId);
    const publishedAt = typeof post?.publishedAt === "string" ? post.publishedAt : "";
    if (!Number.isSafeInteger(externalMessageId) || externalMessageId <= 0 || !Number.isFinite(Date.parse(publishedAt))) return [];
    return [[externalMessageId, {
      externalMessageId,
      text: typeof post?.text === "string" ? post.text.slice(0, 100_000) : "",
      publishedAt: new Date(publishedAt).toISOString(),
    }]];
  })).values()];
  if (candidates.length === 0) return { discovered: 0, imported: 0 };

  const result = await db.query(
    `with candidate as (
       select external_message_id, post_text, published_at
         from jsonb_to_recordset($4::jsonb) as item(
           external_message_id bigint,
           post_text text,
           published_at timestamptz
         )
     )
     insert into posts
       (project_id, user_id, channel_id, text, scheduled_at, status,
        tg_message_id, external_message_id, published_at, publication_origin,
        stats_state, verification_state, last_verified_at, verification_result)
     select $1, $2, $3, candidate.post_text, candidate.published_at, 'published',
            candidate.external_message_id, candidate.external_message_id::text,
            candidate.published_at, 'manual', 'ok', 'verified', now(),
            jsonb_build_object('result', 'seen', 'source', 'telegram_public_feed',
                               'discovered_by', 'channel_sync')
       from candidate
      where not exists (
        select 1
          from publication_parts part
          join posts parent on parent.id = part.post_id and parent.project_id = $1
         where parent.channel_id = $3
           and part.external_message_id = candidate.external_message_id::text
      )
     on conflict (channel_id, external_message_id)
       where external_message_id is not null
     do nothing`,
    [projectId, userId, channelId, JSON.stringify(candidates.map((candidate) => ({
      external_message_id: candidate.externalMessageId,
      post_text: candidate.text,
      published_at: candidate.publishedAt,
    })))],
  );
  return { discovered: candidates.length, imported: Number(result.rowCount || 0) };
}
