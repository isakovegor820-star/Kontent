function telegramChatId(value) {
  const normalized = String(value ?? "").trim();
  return /^-?\d+$/u.test(normalized) ? normalized : null;
}

function telegramMessageId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function telegramPublishedAt(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1_000).toISOString();
}

export function telegramReactionTotal(update) {
  if (!Array.isArray(update?.reactions)) return null;
  return update.reactions.reduce((sum, reaction) => {
    const count = Number(reaction?.total_count);
    return sum + (Number.isSafeInteger(count) && count >= 0 ? count : 0);
  }, 0);
}

/**
 * Persist a channel post delivered by Bot API. This is the real-time path for posts
 * published directly in Telegram; the public-feed collector remains the reconciliation
 * fallback and the source of view counts.
 */
export async function captureTelegramChannelPost(db, message) {
  const chatId = telegramChatId(message?.chat?.id);
  const messageId = telegramMessageId(message?.message_id);
  const publishedAt = telegramPublishedAt(message?.date);
  if (!chatId || !messageId || !publishedAt || message?.chat?.type !== "channel") {
    return { captured: false, reason: "invalid_channel_post" };
  }
  const text = String(message?.text || message?.caption || "").slice(0, 100_000);
  const result = await db.query(
    `with owner as (
       select channel.id as channel_id, channel.project_id, channel.user_id
         from channels channel
        where channel.network = 'tg' and channel.is_active = true
          and channel.tg_chat_id::text = $1
        order by channel.id limit 1
     )
     insert into posts
       (project_id, user_id, channel_id, text, scheduled_at, status,
        tg_message_id, external_message_id, published_at, publication_origin,
        verification_state, last_verified_at, verification_result)
     select owner.project_id, owner.user_id, owner.channel_id, $3, $4, 'published',
            $2, $2::text, $4, 'manual', 'verified', now(),
            jsonb_build_object('result', 'seen', 'source', 'telegram_channel_post')
       from owner
      where not exists (
        select 1
          from publication_parts part
          join posts parent on parent.id = part.post_id
         where parent.project_id = owner.project_id
           and parent.channel_id = owner.channel_id
           and part.external_message_id = $2::text
      )
     on conflict (channel_id, external_message_id)
       where external_message_id is not null
     do update set
       text = case
         when posts.publication_origin = 'manual' and excluded.text <> '' then excluded.text
         else posts.text
       end,
       published_at = coalesce(posts.published_at, excluded.published_at),
       verification_state = 'verified', last_verified_at = now(),
       verification_result = jsonb_build_object('result', 'seen', 'source', 'telegram_channel_post')
     returning id as post_id, project_id, user_id, channel_id, publication_origin`,
    [chatId, messageId, text, publishedAt],
  );
  const row = result.rows?.[0];
  if (!row) return { captured: false, reason: "channel_not_connected" };
  return {
    captured: true,
    postId: Number(row.post_id),
    projectId: Number(row.project_id),
    userId: Number(row.user_id),
    channelId: Number(row.channel_id),
    origin: row.publication_origin,
    messageId,
  };
}

/** Store a precise aggregate reaction-count update without erasing a collected view count. */
export async function captureTelegramReactionCount(db, update, snapshotDate) {
  const chatId = telegramChatId(update?.chat?.id);
  const messageId = telegramMessageId(update?.message_id);
  const reactions = telegramReactionTotal(update);
  if (!chatId || !messageId || reactions == null || !/^\d{4}-\d{2}-\d{2}$/u.test(String(snapshotDate))) {
    return { captured: false, reason: "invalid_reaction_update" };
  }
  const result = await db.query(
    `with target as (
       select post.id as post_id, post.project_id
         from channels channel
         join posts post on post.channel_id = channel.id and post.project_id = channel.project_id
        where channel.network = 'tg' and channel.is_active = true
          and channel.tg_chat_id::text = $1
          and (
            post.tg_message_id = $2
            or post.external_message_id = $2::text
            or exists (
              select 1 from publication_parts part
               where part.post_id = post.id and part.external_message_id = $2::text
            )
          )
          and (select count(*) from publication_parts part where part.post_id = post.id) <= 1
        order by post.published_at desc nulls last, post.id desc limit 1
     ), latest as (
       select target.post_id, target.project_id,
              (select snapshot.views
                 from post_stats snapshot
                where snapshot.post_id = target.post_id and snapshot.project_id = target.project_id
                order by snapshot.snapshot_date desc, snapshot.collected_at desc, snapshot.id desc
                limit 1) as views
         from target
     ), stored as (
       insert into post_stats (project_id, post_id, snapshot_date, views, reactions)
       select latest.project_id, latest.post_id, $3::date, latest.views, $4 from latest
       on conflict (post_id, snapshot_date)
       do update set views = coalesce(post_stats.views, excluded.views),
                     reactions = excluded.reactions, collected_at = now()
       returning post_id, project_id
     )
     update posts post
        set stats_state = 'ok'
       from stored
      where post.id = stored.post_id and post.project_id = stored.project_id
     returning post.id as post_id, post.project_id`,
    [chatId, messageId, snapshotDate, reactions],
  );
  const row = result.rows?.[0];
  return row
    ? { captured: true, postId: Number(row.post_id), projectId: Number(row.project_id), reactions }
    : { captured: false, reason: "post_not_connected" };
}
