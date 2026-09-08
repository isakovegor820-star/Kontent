import type { PoolClient } from "pg";
import { getPool } from "./db";
import { requireProjectPermission, requireSelectedProjectPermission, type ProjectPermission } from "./project-permissions";

/** Lock membership before channel; every subscription writer shares this channel lock. */
export async function withRssChannel<T>(
  userId: number, channelId: number, permission: ProjectPermission,
  task: (client: PoolClient, projectId: number) => Promise<T>,
): Promise<T | null> {
  const pool = getPool();
  const { projectId } = await requireSelectedProjectPermission(pool, userId, permission);
  const client = await pool.connect();
  try {
    await client.query("begin");
    await requireProjectPermission(client, userId, projectId, permission, { lock: true });
    const channel = await client.query(
      `select id from channels where id = $1 and project_id = $2
         and is_active and status = 'active' and network in ('tg', 'vk') for update`, [channelId, projectId],
    );
    if (!channel.rowCount) { await client.query("rollback"); return null; }
    const result = await task(client, projectId);
    await client.query("commit");
    return result;
  } catch (error) { await client.query("rollback").catch(() => {}); throw error; }
  finally { client.release(); }
}

export async function saveRssSubscription(client: PoolClient, input: {
  actorUserId: number; channelId: number; url: string; title: string | null;
  kind: "manual" | "legal_opportunity"; aiSummarize: boolean; publishExisting: boolean;
  maxPerDay: number; autoPublishEnabled?: boolean;
}): Promise<{ id: number; is_active: boolean }> {
  // Reuse a colleague's subscription in this channel. An identically named URL in
  // another project has a different row and cannot be moved by an upsert replay.
  const existing = (await client.query<{ id: string }>(
    "select id from rss_feeds where channel_id = $1 and url = $2 order by id limit 1 for update",
    [input.channelId, input.url],
  )).rows[0];
  const row = existing
    ? (await client.query<{ id: string; is_active: boolean }>(
      `update rss_feeds set title = $2, is_active = $3, ai_summarize = $4,
          publish_existing = $5, source_kind = $6,
          max_per_day = case when $6 = 'legal_opportunity' then greatest(max_per_day, $7) else $7 end,
          auto_publish_enabled = coalesce($8::boolean, auto_publish_enabled), last_fetched_at = null
        where id = $1 returning id, is_active`,
      [existing.id, input.title, input.kind === "legal_opportunity", input.aiSummarize,
        input.publishExisting, input.kind, input.maxPerDay, input.autoPublishEnabled ?? null],
    )).rows[0]
    : (await client.query<{ id: string; is_active: boolean }>(
      `insert into rss_feeds (user_id, channel_id, url, title, is_active, ai_summarize,
          publish_existing, source_kind, max_per_day, auto_publish_enabled)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id, is_active`,
      [input.actorUserId, input.channelId, input.url, input.title, input.kind === "legal_opportunity",
        input.aiSummarize, input.publishExisting, input.kind, input.maxPerDay, input.autoPublishEnabled ?? false],
    )).rows[0];
  return { id: Number(row.id), is_active: row.is_active };
}
