import { PROJECT_ROLES, roleAllows } from "../src/lib/project-role-policy.mjs";
import { AiWorkAccessError } from "../src/lib/ai-work-access.mjs";
const creatorRoles = PROJECT_ROLES.filter(role => roleAllows(role,"content.create")).map(role => `'${role}'`).join(",");

/** This locks the real durable requester and project; no ambient selected project or owner fallback. */
export function siteAnalysisAuthoritySql() {
  return `select analysis.id, analysis.user_id, analysis.project_id, analysis.site_id
    from site_analysis_jobs analysis
    join projects project on project.id=analysis.project_id and not project.is_archived
    join project_members member on member.project_id=project.id and member.user_id=analysis.user_id
      and member.status='active' and member.role in (${creatorRoles})
    join users actor on actor.id=member.user_id and actor.blocked_at is null
    where analysis.id=$1 and analysis.run_revision=$2
      and ($3::bigint is null or analysis.user_id=$3) and ($4::bigint is null or analysis.project_id=$4)
      and (analysis.site_id is null or exists(select 1 from sites site
        where site.id=analysis.site_id and site.project_id=project.id and site.status='active' for share))
    for share of project, member, actor, analysis`;
}
export async function requireSiteAnalysisAiAccess(db, input) {
  const row = (await db.query(siteAnalysisAuthoritySql(), [input.analysisId,input.runRevision,input.userId ?? null,input.projectId ?? null])).rows[0];
  if (!row) throw new AiWorkAccessError();
  return row;
}
export async function withSiteAnalysisAiAccess(pool, input, task) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await requireSiteAnalysisAiAccess(client, input);
    const result = await task(client);
    await client.query("commit");
    return result;
  } catch(error) { await client.query("rollback").catch(()=>{}); throw error; }
  finally { client.release(); }
}
