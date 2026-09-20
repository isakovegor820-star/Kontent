import type { PoolClient } from 'pg';
import { ProjectAccessError, roleAllows, type ProjectPermission, type ProjectRole } from './project-permissions';

/** A short transaction fence after external feed validation; never hold it over HTTP. */
export async function lockRssProject(client: PoolClient, userId: number, projectId: number, permission: ProjectPermission) {
  const result=await client.query<{role:ProjectRole}>(`select member.role from projects project
    join project_members member on member.project_id=project.id and member.user_id=$2
    join users actor on actor.id=member.user_id
    where project.id=$1 and not project.is_archived and member.status='active' and actor.blocked_at is null
    for share of project,member,actor`,[projectId,userId]);
  if(!result.rowCount||!roleAllows(result.rows[0].role,permission))throw new ProjectAccessError('permission_denied');
}
