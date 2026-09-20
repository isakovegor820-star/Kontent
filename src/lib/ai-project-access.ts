import type { Pool, PoolClient } from "pg";
import { getPool } from "./db";
import { PROJECT_ROLES, ProjectAccessError, requireSelectedProjectPermission, roleAllows } from "./project-permissions";

// Derive SQL roles from the shared permission matrix; historical connector identity is
// never an authorization source. Expressions below are source-code identifiers only.
export const AI_CONTENT_ROLES_SQL = PROJECT_ROLES
  .filter((role) => roleAllows(role, "content.create"))
  .map((role) => `'${role}'`).join(", ");

export function aiProjectPermissionSql(project: string, user: string): string {
  return `exists (
    select 1 from project_members ai_member
    join projects ai_project on ai_project.id = ai_member.project_id
    where ai_member.project_id = ${project} and ai_member.user_id = ${user}
      and ai_member.status = 'active' and ai_project.is_archived = false
      and ai_member.role in (${AI_CONTENT_ROLES_SQL})
  )`;
}

export function aiChannelPermissionSql(channel: string, user: string): string {
  return `exists (
    select 1 from channels ai_channel
    where ai_channel.id = ${channel} and ai_channel.is_active = true and ai_channel.status = 'active'
      and ${aiProjectPermissionSql("ai_channel.project_id", user)}
  )`;
}

/** Legacy non-web quota rows do not contain project content or generation artifacts. */
export function aiUsagePermissionSql(usage: string): string {
  return `(${usage}.reservation_key not like 'web:%' or exists (
    select 1 from generation_operations ai_operation
    where ai_operation.ai_usage_id = ${usage}.id and ai_operation.user_id = ${usage}.user_id
      and ${aiChannelPermissionSql("ai_operation.channel_id", `${usage}.user_id`)}
  ))`;
}

/** Route admission precedes context, replay and any provider readiness/request. */
export async function requireAiChannelAccess(
  userId: number,
  channelId: number,
  db: Pick<Pool | PoolClient, "query"> = getPool(),
): Promise<number> {
  const membership = await requireSelectedProjectPermission(db, userId, "content.create");
  const channel = await db.query(
    `select id from channels where id = $1 and project_id = $2
       and is_active = true and status = 'active'
       and ${aiChannelPermissionSql("channels.id", "$3")}`,
    [channelId, membership.projectId, userId],
  );
  if (!channel.rowCount) throw new ProjectAccessError("permission_denied");
  return membership.projectId;
}
