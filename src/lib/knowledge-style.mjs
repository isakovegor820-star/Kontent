/** Explicitly imported channel posts are examples of style, never factual support. */
export async function knowledgeStyleSamples(db, channelId, limit = 5) {
  if (!Number.isSafeInteger(Number(channelId)) || Number(channelId) <= 0) return [];
  const safeLimit = Math.min(10, Math.max(1, Number(limit) || 5));
  const rows = (await db.query(`select raw_text from knowledge_sources
    where channel_id=$1 and kind='channel' and status <> 'error'
    order by added_at desc, id desc limit 1`, [channelId])).rows;
  return (rows[0]?.raw_text || '').split(/\n\s*\n+/u).map(text => text.trim()).filter(text => text.length >= 40).slice(0, safeLimit).map(text => text.slice(0, 2000));
}
