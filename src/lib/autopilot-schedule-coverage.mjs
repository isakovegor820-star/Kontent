// Покрытие уже запланированных постов автопилота — общий контракт для UI и API.
// Источник — календарь (posts), а не план: одобренный пост живёт в posts и может
// относиться к плану, уже помеченному done. Пустое покрытие означает, что
// предупреждать не о чем: новый план честно встанет со завтра.

/**
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export async function computeAutopilotScheduleCoverage(db, projectId, channelId) {
  const row = (await db.query(
    `select count(*)::int as count, max(scheduled_at) as until
       from posts
      where project_id = $1 and channel_id = $2
        and status = 'scheduled' and publication_origin = 'autopilot'
        and scheduled_at > now()`,
    [projectId, channelId],
  )).rows[0];
  const count = Number(row?.count) || 0;
  const until = row?.until ? new Date(row.until).toISOString() : null;
  return { count, until };
}
