import { roleAllows } from "../src/lib/project-role-policy.mjs";

export class ResearchProjectAccessError extends Error {
  constructor() { super("research_project_access_denied"); this.name = "ResearchProjectAccessError"; }
}

export async function requireResearchWorkerScope(db, userId, channelId, expectedProjectId = null) {
  if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0
    || (channelId !== null && (!Number.isSafeInteger(Number(channelId)) || Number(channelId) <= 0))
    || (channelId === null && (!Number.isSafeInteger(Number(expectedProjectId)) || Number(expectedProjectId) <= 0))) throw new ResearchProjectAccessError();
  const row = (await db.query(
    `select project.id as project_id, member.role from projects project
       join project_members member on member.project_id=project.id and member.user_id=$1 and member.status='active'
       join users actor on actor.id=member.user_id and actor.blocked_at is null
       left join channels channel on channel.id=$2 and channel.project_id=project.id
      where not project.is_archived and (($2::bigint is null and project.id=$3)
        or (channel.id=$2 and channel.is_active and channel.status='active'))`,
    [userId, channelId, expectedProjectId],
  )).rows[0];
  if (!row || !roleAllows(row.role, "content.create")
    || (expectedProjectId !== null && Number(row.project_id) !== Number(expectedProjectId))) throw new ResearchProjectAccessError();
  return { userId: Number(userId), channelId: channelId === null ? null : Number(channelId), projectId: Number(row.project_id) };
}

/** Recheck/hold current authority for persistence after potentially slow collection. */
export async function withResearchWorkerWrite(pool, scope, action, options = {}) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='30s'");
    await client.query("select id from projects where id=$1 for share", [scope.projectId]);
    await client.query("select user_id from project_members where project_id=$1 and user_id=$2 for share", [scope.projectId, scope.userId]);
    await client.query("select id from users where id=$1 for share", [scope.userId]);
    if (scope.channelId !== null) await client.query(`select id from channels where id=$1 for ${options.channelLock === "update" ? "update" : "share"}`, [scope.channelId]);
    await requireResearchWorkerScope(client, scope.userId, scope.channelId, scope.projectId);
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally { client.release(); }
}

export async function requireRadarWorkerScope(db, runId, userId) {
  const run = (await db.query("select project_id,channel_id from radar_search_runs where id=$1 and user_id=$2", [runId,userId])).rows[0];
  if (!run?.project_id) throw new ResearchProjectAccessError();
  return requireResearchWorkerScope(db, Number(userId), run.channel_id === null ? null : Number(run.channel_id), Number(run.project_id));
}
