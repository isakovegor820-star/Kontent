import { normalizePostQuality } from "../src/lib/post-quality.mjs";

/** Only explicit examples or externally verified live posts from this exact channel. */
export async function loadBotIdeaStyleSamples(pool, userIdValue, channelIdValue, limitValue = 8) {
  const userId = Number(userIdValue);
  const channelId = Number(channelIdValue);
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new TypeError("bot idea: invalid user");
  if (!Number.isSafeInteger(channelId) || channelId <= 0) throw new TypeError("bot idea: invalid channel");
  const limit = Math.min(20, Math.max(1, Math.round(Number(limitValue) || 8)));

  const liveSamples = (
    await pool.query(
      `select p.text from posts p
        where p.user_id = $1 and p.channel_id = $2
          and p.status = 'published' and p.verification_state = 'verified'
          and length(trim(p.text)) > 0
          and not exists (select 1 from rss_items i where i.post_id = p.id)
        order by p.published_at desc nulls last limit $3`,
      [userId, channelId, limit],
    )
  ).rows.map((row) => String(row.text || "").trim()).filter(Boolean);
  const qualityRow = (
    await pool.query(
      `select quality from content_brief where user_id = $1 and channel_id = $2`,
      [userId, channelId],
    )
  ).rows[0];
  const approvedSamples = normalizePostQuality(qualityRow?.quality).styleExamples;
  return [...new Set([...approvedSamples, ...liveSamples])].slice(0, limit);
}
