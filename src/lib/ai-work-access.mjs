import { roleAllows } from "./project-role-policy.mjs";

export class AiWorkAccessError extends Error {
  constructor(code = "ai_work_scope_forbidden") { super(code); this.name = "AiWorkAccessError"; this.code = code; }
}

/** Authorization is independent of provider prices and user-visible usage refunds.
 * A transaction caller keeps the shared locks through its local read/write phase.
 * At a provider boundary this is a short admission check: an already admitted
 * request may finish after revoke, but subsequent attempts and persistence recheck.
 */
export async function requireAiWorkAccess(db, { userId, projectId, permission = "content.create" }) {
  if (![userId, projectId].every(value => Number.isSafeInteger(Number(value)) && Number(value) > 0)) {
    throw new AiWorkAccessError("ai_work_scope_required");
  }
  const result = await db.query(`select member.role from projects project
    join project_members member on member.project_id = project.id and member.user_id = $2
    join users actor on actor.id = member.user_id and actor.blocked_at is null
    where project.id = $1 and project.is_archived = false and member.status = 'active'
    for share of project, member, actor`, [projectId, userId]);
  if (!result.rows[0] || !roleAllows(result.rows[0].role, permission)) throw new AiWorkAccessError();
}
