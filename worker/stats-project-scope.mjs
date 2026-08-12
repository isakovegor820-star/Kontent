/**
 * Durable stats jobs carry both identities explicitly:
 * - userId is the actor / Telegram report recipient;
 * - projectId is the only data boundary used by collectors and reports.
 *
 * Old queue payloads without projectId fail closed. Resolving them from all data owned by
 * userId would mix collaborative projects and could leak another project's analytics.
 */
export class StatsProjectScopeError extends Error {
  constructor(code, jobName) {
    super(`${jobName}: ${code}`);
    this.name = "StatsProjectScopeError";
    this.code = code;
  }
}
function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function requireStatsProjectId(value, jobName = "stats") {
  const projectId = positiveInteger(value);
  if (projectId == null) throw new StatsProjectScopeError("bad projectId", jobName);
  return projectId;
}

export async function requireStatsJobProjectScope(pool, data, jobName) {
  const userId = positiveInteger(data?.userId);
  if (userId == null) throw new StatsProjectScopeError("bad userId", jobName);
  const projectId = requireStatsProjectId(data?.projectId, jobName);

  const membership = (
    await pool.query(
      `select member.role
         from project_members member
         join projects project on project.id = member.project_id
        where member.project_id = $1
          and member.user_id = $2
          and member.status = 'active'
          and project.is_archived = false
        limit 1`,
      [projectId, userId],
    )
  ).rows[0];

  if (!membership) throw new StatsProjectScopeError("project access denied", jobName);
  return { userId, projectId, role: membership.role };
}
