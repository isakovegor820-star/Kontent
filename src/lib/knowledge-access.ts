import type { Pool, PoolClient } from "pg";
import { ProjectAccessError, requireProjectPermission, requireSelectedProjectPermission, type ProjectPermission } from "./project-permissions";

type Queryable = Pick<PoolClient, "query">;
export type KnowledgeChannel = {
  id: number;
  projectId: number;
  title: string | null;
  handle: string | null;
};

export class KnowledgeAccessError extends Error {
  constructor(readonly code: "no_channel" | "not_found" | "bad_channel") {
    super(code);
  }
}

export function knowledgeChannelSelector(value: unknown): number | null {
  if (value == null || value === "") return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new KnowledgeAccessError("bad_channel");
  return id;
}

/** An explicit channel identifies its project; changing the user's selection never retargets it. */
export async function requireKnowledgeChannel(
  db: Queryable,
  userId: number,
  wanted: number | null,
  permission: ProjectPermission,
  lock = false,
): Promise<KnowledgeChannel> {
  const selectedProject = wanted == null
    ? (await requireSelectedProjectPermission(db, userId, permission)).projectId
    : null;
  const row = (await db.query<{ id: string; project_id: string; title: string | null; handle: string | null }>(
    `select id, project_id, title, handle from channels
      where ($1::bigint is null or id = $1) and ($2::bigint is null or project_id = $2)
        and network = 'tg' and is_active = true order by id limit 1`,
    [wanted, selectedProject],
  )).rows[0];
  if (!row) throw new KnowledgeAccessError("no_channel");
  const projectId = Number(row.project_id);
  await requireProjectPermission(db, userId, projectId, permission, { lock });
  if (lock) {
    // Membership -> parent -> source is the common order for source writers. Serializing
    // replacements on the parent prevents two team members retaining stale profiles.
    const parent = await db.query(`select id from channels
      where id=$1 and project_id=$2 and is_active=true ${permission === "project.read" ? "for share" : "for update"}`, [row.id, projectId]);
    if (!parent.rowCount) throw new KnowledgeAccessError("no_channel");
  }
  return { id: Number(row.id), projectId, title: row.title, handle: row.handle };
}

export async function withKnowledgeChannel<T>(
  pool: Pick<Pool, "connect">,
  userId: number,
  channelId: number | null,
  permission: ProjectPermission,
  task: (db: PoolClient, channel: KnowledgeChannel) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const channel = await requireKnowledgeChannel(db, userId, channelId, permission, true);
    const result = await task(db, channel);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

export async function deleteKnowledgeSource(pool: Pick<Pool, "connect">, userId: number, sourceId: number) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const source = (await db.query<{ channel_id: string | null; site_id: string | null; project_id: string | null }>(
      `select source.channel_id, source.site_id, coalesce(channel.project_id, site.project_id) as project_id
         from knowledge_sources source
         left join channels channel on channel.id=source.channel_id
         left join sites site on site.id=source.site_id
        where source.id=$1`, [sourceId],
    )).rows[0];
    if (!source?.project_id) throw new KnowledgeAccessError("not_found");
    await requireProjectPermission(db, userId, Number(source.project_id), "content.edit", { lock: true });
    const parent = source.channel_id != null
      ? await db.query("select id from channels where id=$1 and project_id=$2 for update", [source.channel_id, source.project_id])
      : await db.query("select id from sites where id=$1 and project_id=$2 for update", [source.site_id, source.project_id]);
    if (!parent.rowCount) throw new KnowledgeAccessError("not_found");
    const deleted = await db.query(`delete from knowledge_sources
      where id=$1 and channel_id is not distinct from $2::bigint and site_id is not distinct from $3::bigint`,
    [sourceId, source.channel_id, source.site_id]);
    if (!deleted.rowCount) throw new KnowledgeAccessError("not_found");
    await db.query("commit");
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

export function knowledgeFailure(error: unknown): { error: string; status: number } | null {
  if (error instanceof ProjectAccessError) return { error: "access_denied", status: 403 };
  if (error instanceof KnowledgeAccessError) {
    return { error: error.code, status: error.code === "not_found" ? 404 : 422 };
  }
  return null;
}
