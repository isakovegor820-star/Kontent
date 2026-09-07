import { PROJECT_ROLES, roleAllows } from '../src/lib/project-role-policy.mjs';

/** Source-owned identifiers only; the actor/project values remain SQL parameters. */
export function rssAccessSql(projectExpression, userExpression) {
  const roles=PROJECT_ROLES.filter(role=>roleAllows(role,'content.create')).map(role=>`'${role}'`).join(',');
  return `exists(select 1 from project_members rss_member
    join projects rss_project on rss_project.id=rss_member.project_id
    join users rss_actor on rss_actor.id=rss_member.user_id
    where rss_member.project_id=${projectExpression} and rss_member.user_id=${userExpression}
      and rss_member.status='active' and rss_member.role in (${roles})
      and not rss_project.is_archived and rss_actor.blocked_at is null)`;
}
