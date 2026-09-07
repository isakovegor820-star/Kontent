import type { Pool, PoolClient } from "pg";
import {
  ProjectAccessError,
  requireSelectedProjectPermission,
  roleAllows,
  type ProjectPermission,
  type ProjectRole,
  type ActiveProjectMembership,
} from "./project-permissions";

/** Keep current authority stable until this research read/write has completed. */
export async function withSelectedProjectPermission<T>(
  pool: Pool,
  userId: number,
  permission: ProjectPermission,
  action: (client: PoolClient, membership: ActiveProjectMembership) => Promise<T>,
  options: { actorLock?: "share" | "update"; projectLock?: "share" | "update" } = {},
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='30s'");
    const membership = await requireSelectedProjectPermission(client, userId, permission);
    // Separate lock statements preserve the same project -> member -> actor order
    // as publication admission. Recheck after each lock, rather than trusting a
    // cookie role or the earlier non-locking membership lookup.
    const project = await client.query(
      `select id from projects where id=$1 and not is_archived for ${options.projectLock === "update" ? "update" : "share"}`,
      [membership.projectId],
    );
    const member = await client.query<{ role: ProjectRole; version: number | string }>(
      "select role, version from project_members where project_id=$1 and user_id=$2 and status='active' for share",
      [membership.projectId, userId],
    );
    const actor = await client.query(
      `select id from users where id=$1 and blocked_at is null for ${options.actorLock === "update" ? "update" : "share"}`,
      [userId],
    );
    if (!project.rowCount || !actor.rowCount || !member.rows[0] || !roleAllows(member.rows[0].role, permission)) {
      throw new ProjectAccessError("permission_denied");
    }
    const result = await action(client, { ...membership, role: member.rows[0].role, version: Number(member.rows[0].version) });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
